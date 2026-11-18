import { Op, UniqueConstraintError } from "sequelize";
import {
  Category, IntegrationInbox, IntegrationOutbox, Inventory, Product, StockMovement,
  StockReservation, Supplier, sequelize
} from "../models/index.js";
import { emitIntegrationEvent, recordMovement } from "./inventoryService.js";
import { makeExternalReference, validateCrmEvent } from "./integrationValidation.js";
import { formatMoney } from "./money.js";

const conflict = (message, code = "conflict", details = undefined) => {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const findDuplicateEvent = async event => {
  const serializedEvent = JSON.stringify(event);
  const priorById = await IntegrationInbox.findOne({
    where: { source: "crm", eventId: event.eventId }
  });
  if (priorById) {
    if (priorById.payload !== serializedEvent) {
      throw conflict("eventId has already been used with a different event body.");
    }
    return {
      eventId: event.eventId,
      duplicate: true,
      result: JSON.parse(priorById.response || "{}")
    };
  }

  const transactionReference = event.transactionReference || event.orderReference;
  if (!transactionReference) return null;
  const priorByReference = await IntegrationInbox.findOne({
    where: { source: "crm", eventType: event.eventType, transactionReference }
  });
  if (!priorByReference) return null;
  const priorPayload = JSON.parse(priorByReference.payload);
  const sameBusinessEvent = priorPayload.orderReference === event.orderReference &&
    priorPayload.transactionReference === event.transactionReference &&
    JSON.stringify(priorPayload.items || []) === JSON.stringify(event.items || []);
  if (!sameBusinessEvent) {
    throw conflict("The transaction reference has already been used with different event data.");
  }
  return {
    eventId: event.eventId,
    duplicate: true,
    result: JSON.parse(priorByReference.response || "{}")
  };
};

const getAvailableStock = async (productId, inventory, transaction) => {
  const reserved = Number(await StockReservation.sum("quantity", {
    where: { ProductId: productId, status: "active" },
    transaction
  }) || 0);
  return { reserved, available: inventory.quantity - reserved };
};

const processEvent = async (event, transaction) => {
  if (event.eventType === "order.confirmed") {
    // Phase 1: lock and check every line (in product-ID order, to avoid deadlocks)
    // before writing anything. Any problem rejects the whole order with no reservation.
    const lines = [];
    const shortages = [];
    for (const item of [...event.items].sort((a, b) => a.productId - b.productId)) {
      const product = await Product.findOne({
        where: { id: item.productId, isActive: true },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!product) {
        throw conflict(`Product ${item.productId} is unavailable.`, "product_unavailable", { productId: item.productId });
      }
      const inventory = await Inventory.findOne({
        where: { ProductId: product.id },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!inventory) throw new Error(`Inventory record is missing for product ${product.id}.`);
      const existing = await StockReservation.findOne({
        where: { orderReference: event.orderReference, ProductId: product.id },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (existing) {
        if (existing.status === "active" && existing.quantity === item.quantity) {
          lines.push({ item, product, existing });
          continue;
        }
        throw conflict(
          `Order ${event.orderReference} already has a reservation for product ${product.id}.`,
          "reservation_conflict",
          { orderReference: event.orderReference, productId: product.id }
        );
      }
      const { available } = await getAvailableStock(product.id, inventory, transaction);
      if (item.quantity > available) {
        shortages.push({
          productId: product.id,
          sku: product.sku,
          requestedQuantity: item.quantity,
          availableStock: Math.max(available, 0)
        });
      }
      lines.push({ item, product, available });
    }
    if (shortages.length) {
      throw conflict(
        shortages.length === 1
          ? `Insufficient available stock for ${lines.find(line => line.product.id === shortages[0].productId).product.name}.`
          : `Insufficient available stock for ${shortages.length} products.`,
        "insufficient_stock",
        { orderReference: event.orderReference, reserved: false, shortages }
      );
    }

    // Phase 2: every line fits, so reserve them all (same transaction).
    const byProduct = new Map(lines.map(line => [line.product.id, line]));
    const reservations = [];
    for (const item of event.items) {
      const { product, existing, available } = byProduct.get(item.productId);
      if (existing) {
        reservations.push({ productId: product.id, quantity: item.quantity, status: "already_reserved" });
        continue;
      }
      await StockReservation.create({
        orderReference: event.orderReference,
        ProductId: product.id,
        quantity: item.quantity,
        status: "active"
      }, { transaction });
      await emitIntegrationEvent({
        eventType: "StockReserved",
        transactionReference: event.orderReference,
        payload: { orderReference: event.orderReference, productId: product.id, sku: product.sku, quantity: item.quantity },
        transaction
      });
      if (available - item.quantity === 0) {
        await emitIntegrationEvent({
          eventType: "ProductUnavailable",
          transactionReference: `reserved:${event.orderReference}:${product.id}`,
          payload: { productId: product.id, sku: product.sku },
          transaction
        });
      }
      reservations.push({ productId: product.id, quantity: item.quantity, status: "reserved" });
    }
    return { orderReference: event.orderReference, reservations };
  }

  if (event.eventType === "sale.completed") {
    const existingReservations = await StockReservation.findAll({
      where: { orderReference: event.orderReference },
      include: [Product],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const reservations = existingReservations.filter(item => item.status === "active");
    const externalReferences = existingReservations.map(item =>
      makeExternalReference("sale", event.transactionReference, item.ProductId)
    );
    if (reservations.length === 0) {
      const existingMovements = externalReferences.length
        ? await StockMovement.count({ where: { externalReference: { [Op.in]: externalReferences } }, transaction })
        : 0;
      if (existingReservations.length && existingMovements === existingReservations.length) {
        return { orderReference: event.orderReference, transactionReference: event.transactionReference, status: "already_deducted" };
      }
      throw conflict(`Order ${event.orderReference} has no active stock reservation.`);
    }

    for (const reservation of reservations) {
      const externalReference = makeExternalReference("sale", event.transactionReference, reservation.ProductId);
      const existingMovement = await StockMovement.findOne({ where: { externalReference }, transaction });
      if (existingMovement) throw conflict("This sale transaction reference has already deducted stock.");
    }

    for (const reservation of reservations) {
      await reservation.update({ status: "consumed" }, { transaction });
      await recordMovement({
        productId: reservation.ProductId,
        movementType: "stock_out",
        quantity: reservation.quantity,
        remarks: `Sale completed for ${event.orderReference}`,
        source: "crm",
        externalReference: makeExternalReference("sale", event.transactionReference, reservation.ProductId),
        transaction
      });
    }
    return {
      orderReference: event.orderReference,
      transactionReference: event.transactionReference,
      productsDeducted: reservations.length
    };
  }

  if (event.eventType === "order.cancelled") {
    const reservations = await StockReservation.findAll({
      where: { orderReference: event.orderReference },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (reservations.some(item => item.status === "consumed")) {
      throw conflict(`Order ${event.orderReference} has already been fulfilled and cannot release stock.`);
    }
    let released = 0;
    for (const reservation of reservations.filter(item => item.status === "active")) {
      await reservation.update({ status: "released" }, { transaction });
      const product = await Product.findByPk(reservation.ProductId, { transaction });
      await emitIntegrationEvent({
        eventType: "StockReleased",
        transactionReference: event.orderReference,
        payload: {
          orderReference: event.orderReference,
          productId: reservation.ProductId,
          sku: product?.sku || null,
          quantity: reservation.quantity
        },
        transaction
      });
      released += 1;
    }
    return { orderReference: event.orderReference, productsReleased: released };
  }

  if (event.eventType === "return.received") {
    for (const item of event.items) {
      const product = await Product.findOne({
        where: { id: item.productId, isActive: true },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!product) throw conflict(`Product ${item.productId} is unavailable.`);
      const externalReference = makeExternalReference("return", event.transactionReference, product.id);
      if (await StockMovement.findOne({ where: { externalReference }, transaction })) {
        throw conflict("This return transaction reference has already changed stock.");
      }
      await recordMovement({
        productId: product.id,
        movementType: "stock_in",
        quantity: item.quantity,
        remarks: `Customer return ${event.transactionReference}`,
        source: "crm",
        externalReference,
        transaction
      });
      await emitIntegrationEvent({
        target: "accounting",
        eventType: "InventoryReturnReceived",
        transactionReference: event.transactionReference,
        payload: { productId: product.id, sku: product.sku, quantity: item.quantity },
        transaction
      });
    }
    return { transactionReference: event.transactionReference, productsReceived: event.items.length };
  }

  await emitIntegrationEvent({
    target: "accounting",
    eventType: "RefundReported",
    transactionReference: event.transactionReference,
    payload: { orderReference: event.orderReference, transactionReference: event.transactionReference },
    transaction
  });
  return { orderReference: event.orderReference, transactionReference: event.transactionReference, status: "reported" };
};

export const receiveCrmEvent = async input => {
  const event = validateCrmEvent(input);
  const serializedEvent = JSON.stringify(event);
  const duplicate = await findDuplicateEvent(event);
  if (duplicate) return duplicate;
  try {
    return await sequelize.transaction(async transaction => {
      const result = await processEvent(event, transaction);
      await IntegrationInbox.create({
        eventId: event.eventId,
        source: "crm",
        eventType: event.eventType,
        transactionReference: event.transactionReference || event.orderReference || null,
        payload: serializedEvent,
        status: "processed",
        response: JSON.stringify(result)
      }, { transaction });
      return { eventId: event.eventId, duplicate: false, result };
    });
  } catch (error) {
    const duplicateAfterConflict = await findDuplicateEvent(event);
    if (duplicateAfterConflict) return duplicateAfterConflict;
    if (error instanceof UniqueConstraintError) throw error;
    throw error;
  }
};

export const listProducts = async ({ search = "", productId, limit = 100, offset = 0 } = {}) => {
  const where = { isActive: true };
  if (productId !== undefined) where.id = Number(productId);
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { sku: { [Op.like]: `%${search}%` } }
    ];
  }
  const products = await Product.findAll({
    where,
    include: [Inventory, Category, Supplier],
    order: [["id", "ASC"]],
    limit,
    offset
  });
  const reservedRows = await StockReservation.findAll({
    attributes: ["ProductId", [sequelize.fn("SUM", sequelize.col("quantity")), "reserved"]],
    where: { status: "active", ProductId: { [Op.in]: products.map(product => product.id) } },
    group: ["ProductId"],
    raw: true
  });
  const reservedByProduct = new Map(reservedRows.map(row => [Number(row.ProductId), Number(row.reserved)]));
  return products.map(product => {
    const physicalStock = product.Inventory?.quantity ?? product.currentStock;
    const reservedStock = reservedByProduct.get(product.id) || 0;
    return {
      id: product.id,
      sku: product.sku,
      barcode: product.sku,
      name: product.name,
      description: product.description,
      category: product.Category?.name || null,
      unit: product.unit,
      price: formatMoney(product.unitPrice),
      imagePath: product.imagePath,
      supplier: product.Supplier ? { id: product.Supplier.id, name: product.Supplier.name } : null,
      physicalStock,
      reservedStock,
      availableStock: physicalStock - reservedStock,
      minimumStock: product.minimumStock,
      status: product.isActive ? "active" : "inactive"
    };
  });
};

export const getProduct = async id => (await listProducts({ productId: id, limit: 1 }))[0] || null;

export const listOutboxEvents = async (target, limit) => {
  const events = await IntegrationOutbox.findAll({
    where: { target, publishedAt: null },
    order: [["createdAt", "ASC"]],
    limit
  });
  return events.map(event => ({
    eventId: event.eventId,
    eventType: event.eventType,
    transactionReference: event.transactionReference,
    occurredAt: event.createdAt,
    data: JSON.parse(event.payload)
  }));
};

export const acknowledgeOutboxEvent = async (target, eventId) => {
  const [updated] = await IntegrationOutbox.update(
    { publishedAt: new Date() },
    { where: { target, eventId, publishedAt: null } }
  );
  if (updated === 1) return true;
  const existing = await IntegrationOutbox.findOne({
    where: { target, eventId },
    attributes: ["publishedAt"]
  });
  return Boolean(existing?.publishedAt);
};
