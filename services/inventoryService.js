import { Op } from "sequelize";
import {
  IntegrationOutbox, Inventory, LowStockAlert, Notification, Product, Role,
  StockMovement, StockReservation, User
} from "../models/index.js";

export const getReservedQuantity = async (productId, transaction) => {
  const quantity = await StockReservation.sum("quantity", {
    where: { ProductId: productId, status: "active" },
    transaction
  });
  return Number(quantity || 0);
};

export const emitIntegrationEvent = async ({
  target = "crm", eventType, transactionReference = null, payload, transaction
}) => IntegrationOutbox.create({
  target,
  eventType,
  transactionReference,
  payload: JSON.stringify(payload)
}, { transaction });

export const recordMovement = async ({
  productId, movementType, quantity, remarks, userId, transaction,
  source = "manual", externalReference = null
}) => {
  const product = await Product.findByPk(productId, {
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!product || !product.isActive) throw new Error("Product not found or inactive.");
  if (!["stock_in", "stock_out", "adjustment"].includes(movementType)) {
    throw new Error("Unsupported stock movement type.");
  }

  const inventory = await Inventory.findOne({
    where: { ProductId: product.id },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!inventory) throw new Error("Inventory record is missing for this product.");

  if (!Number.isInteger(quantity) || quantity < 0 ||
      (movementType !== "adjustment" && quantity < 1)) {
    throw new Error("Movement quantity must be a valid whole number.");
  }

  const previousStock = inventory.quantity;
  const reservedQuantity = await getReservedQuantity(product.id, transaction);
  let updatedStock;
  if (movementType === "stock_in") updatedStock = previousStock + quantity;
  else if (movementType === "stock_out") updatedStock = previousStock - quantity;
  else updatedStock = quantity;

  if (updatedStock < 0) throw new Error("Stock cannot be reduced below zero.");
  if (movementType === "stock_out" && quantity > previousStock - reservedQuantity) {
    throw new Error("Stock cannot be reduced below the quantity reserved for confirmed orders.");
  }
  if (movementType === "adjustment" && updatedStock < reservedQuantity) {
    throw new Error("The counted stock cannot be lower than the quantity reserved for confirmed orders.");
  }
  const movementQuantity = movementType === "adjustment"
    ? Math.abs(updatedStock - previousStock)
    : quantity;
  if (movementQuantity === 0) throw new Error("The adjustment does not change the current stock.");

  await inventory.update({ quantity: updatedStock }, { transaction });
  await product.update({ currentStock: updatedStock }, { transaction });
  const movement = await StockMovement.create({
    ProductId: product.id,
    movementType,
    quantity: movementQuantity,
    previousStock,
    updatedStock,
    remarks: remarks || null,
    recordedById: userId || null,
    source,
    externalReference
  }, { transaction });
  const availableStock = updatedStock - reservedQuantity;
  const eventType = movementType === "stock_in"
    ? "StockReceived"
    : movementType === "stock_out" ? "StockDeducted" : "StockAdjusted";
  await emitIntegrationEvent({
    eventType,
    transactionReference: externalReference || `movement:${movement.id}`,
    payload: {
      productId: product.id,
      sku: product.sku,
      quantity: movementQuantity,
      previousStock,
      currentStock: updatedStock,
      reservedStock: reservedQuantity,
      availableStock,
      source
    },
    transaction
  });
  if (availableStock === 0) {
    await emitIntegrationEvent({
      eventType: "ProductUnavailable",
      transactionReference: externalReference || `unavailable:${product.id}:${movement.id}`,
      payload: { productId: product.id, sku: product.sku },
      transaction
    });
  }

  if (updatedStock <= product.minimumStock) {
    const [alert, created] = await LowStockAlert.findOrCreate({
      where: { ProductId: product.id, status: "active" },
      defaults: {
        ProductId: product.id,
        currentStock: updatedStock,
        minimumStock: product.minimumStock,
        status: "active"
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!created) await alert.update({
      currentStock: updatedStock,
      minimumStock: product.minimumStock
    }, { transaction });

    if (created) {
      await emitIntegrationEvent({
        eventType: "LowStockDetected",
        transactionReference: `low-stock:${product.id}:${movement.id}`,
        payload: { productId: product.id, sku: product.sku, currentStock: updatedStock, minimumStock: product.minimumStock },
        transaction
      });
      const recipients = await User.findAll({
        where: { isActive: true },
        include: [{ model: Role, where: { name: { [Op.in]: ["manager", "supervisor", "staff"] } } }],
        transaction
      });
      await Notification.bulkCreate(recipients.map(recipient => ({
        UserId: recipient.id,
        ProductId: product.id,
        message: `${product.name} is low on stock (${updatedStock} ${product.unit} remaining; minimum ${product.minimumStock}).`
      })), { transaction });
    }
  } else {
    await LowStockAlert.update(
      { status: "resolved", resolvedAt: new Date(), currentStock: updatedStock },
      { where: { ProductId: product.id, status: "active" }, transaction }
    );
  }

  return { product, movement, previousStock, updatedStock };
};
