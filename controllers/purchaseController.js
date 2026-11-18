import { randomBytes } from "node:crypto";
import { Op } from "sequelize";
import {
  Category, Product, PurchaseOrder, PurchaseOrderItem, StockMovement, Supplier, User, sequelize
} from "../models/index.js";
import { emitIntegrationEvent, recordMovement } from "../services/inventoryService.js";
import { makeFields, renderModule } from "./viewHelpers.js";
import { formatMoney, multiplyMoney, parseMoney } from "../services/money.js";

const orderNumber = () => `PO-${Date.now()}-${randomBytes(2).toString("hex").toUpperCase()}`;
const stockStatus = product => product.currentStock <= 0
  ? "Out of stock"
  : product.currentStock <= product.minimumStock ? "Low stock" : "In stock";

export const purchaseOrdersPage = async (req, res) => {
  const orders = await PurchaseOrder.findAll({
    include: [Supplier, { model: User, as: "createdBy" }, { model: PurchaseOrderItem, as: "items" }],
    order: [["createdAt", "DESC"]]
  });
  const suppliers = await Supplier.findAll({ where: { status: "active" }, order: [["name", "ASC"]] });
  const products = await Product.findAll({ where: { isActive: true }, order: [["name", "ASC"]] });
  renderModule(res, {
    title: "Purchase orders",
    subtitle: "Order replenishment and receive delivered quantities into stock.",
    section: "purchase-orders",
    columns: ["Order", "Supplier", "Items", "Status", "Created", "Created by"],
    rows: orders.map(order => ({
      id: order.id,
      href: `/purchase-orders/${order.id}`,
      cells: [order.orderNumber, order.Supplier.name, order.items.length, order.status.replace("_", " "), order.createdAt.toLocaleDateString(), order.createdBy.name]
    })),
    showForm: true,
    formTitle: "Create purchase order",
    formAction: "/purchase-orders",
    fields: makeFields([
      ["supplierId", "Supplier", "select", true, [{ value: "", label: "Select a supplier" }, ...suppliers.map(supplier => ({ value: supplier.id, label: supplier.name }))]],
      ["productId", "First product", "select", true, [{ value: "", label: "Select a product" }, ...products.map(product => ({ value: product.id, label: `${product.name} (${product.sku})` }))]],
      ["quantity", "Quantity", "number", true],
      ["unitPrice", "Unit price", "number", true],
      ["notes", "Notes", "textarea"]
    ]),
    summaryLines: [{ label: "Additional products can be added after the order is created." }]
  });
};

export const createPurchaseOrder = async (req, res) => {
  const supplierId = Number(req.body.supplierId);
  const productId = Number(req.body.productId);
  const quantity = Number(req.body.quantity);
  const unitPrice = parseMoney(req.body.unitPrice);
  if (!Number.isInteger(supplierId) || !Number.isInteger(productId) ||
      !Number.isInteger(quantity) || quantity < 1 || unitPrice === null) {
    throw new Error("Select a supplier and product and enter valid quantity and unit price.");
  }
  await sequelize.transaction(async transaction => {
    const [supplier, product] = await Promise.all([
      Supplier.findOne({ where: { id: supplierId, status: "active" }, transaction }),
      Product.findOne({ where: { id: productId, isActive: true }, transaction })
    ]);
    if (!supplier || !product) throw new Error("The selected supplier or product is unavailable.");
    const order = await PurchaseOrder.create({
      orderNumber: orderNumber(), SupplierId: supplier.id, createdById: req.user.id, notes: req.body.notes || null
    }, { transaction });
    await PurchaseOrderItem.create({
      PurchaseOrderId: order.id, ProductId: product.id, quantity, unitPrice
    }, { transaction });
    await emitIntegrationEvent({
      target: "accounting",
      eventType: "PurchaseOrderCreated",
      transactionReference: order.orderNumber,
      payload: {
        orderNumber: order.orderNumber,
        supplierId: supplier.id,
        supplierName: supplier.name,
        items: [{ productId: product.id, sku: product.sku, quantity, unitPrice }]
      },
      transaction
    });
  });
  req.flash("success_msg", "Purchase order created.");
  res.redirect("/purchase-orders");
};

export const purchaseOrderDetailsPage = async (req, res) => {
  const order = await PurchaseOrder.findByPk(Number(req.params.id), {
    include: [Supplier, { model: User, as: "createdBy" }, {
      model: PurchaseOrderItem, as: "items", include: [Product]
    }]
  });
  if (!order) throw new Error("Purchase order not found.");
  const products = await Product.findAll({ where: { isActive: true }, order: [["name", "ASC"]] });
  renderModule(res, {
    title: order.orderNumber,
    subtitle: `${order.Supplier.name} · ${order.status.replace("_", " ")} · created ${order.createdAt.toLocaleString()}`,
    section: "purchase-order-details",
    columns: ["Product", "SKU", "Ordered", "Received", "Remaining", "Unit price"],
    rows: order.items.map(item => ({
      id: item.id,
      cells: [
        item.Product.name, item.Product.sku, item.quantity, item.receivedQuantity,
        item.quantity - item.receivedQuantity, Number(item.unitPrice).toFixed(2)
      ],
      receiveAction: ["approved", "ordered", "partially_received"].includes(order.status) && item.quantity > item.receivedQuantity
        ? `/purchase-orders/${order.id}/receive?item=${item.id}`
        : ""
    })),
    showForm: order.status === "pending",
    formTitle: "Add product to this order",
    formAction: `/purchase-orders/${order.id}/items`,
    fields: makeFields([
      ["productId", "Product", "select", true, [{ value: "", label: "Select a product" }, ...products.map(product => ({ value: product.id, label: product.name }))]],
      ["quantity", "Quantity", "number", true],
      ["unitPrice", "Unit price", "number", true]
    ]),
    statusFormAction: `/purchase-orders/${order.id}/status`,
    statusValue: order.status,
    statusOptions: ({
      pending: ["approved", "cancelled"],
      approved: ["ordered", "cancelled"],
      ordered: ["cancelled"]
    }[order.status] || []).map(value => ({ value, label: value.replace("_", " ") })),
    canManage: req.user.Role.name === "manager" && ["pending", "approved", "ordered"].includes(order.status),
    summaryLines: [
      { label: "Created by", value: order.createdBy.name },
      { label: "Notes", value: order.notes || "—" }
    ]
  });
};

export const addPurchaseOrderItem = async (req, res) => {
  const orderId = Number(req.params.id);
  const productId = Number(req.body.productId);
  const quantity = Number(req.body.quantity);
  const unitPrice = parseMoney(req.body.unitPrice);
  await sequelize.transaction(async transaction => {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    const product = await Product.findOne({ where: { id: productId, isActive: true }, transaction });
    if (!order || !product || order.status !== "pending") throw new Error("Products can only be added to a pending purchase order.");
    if (!Number.isInteger(quantity) || quantity < 1 || unitPrice === null) throw new Error("Enter a valid quantity and unit price.");
    await PurchaseOrderItem.create({
      PurchaseOrderId: order.id, ProductId: product.id, quantity, unitPrice
    }, { transaction });
    const supplier = await Supplier.findByPk(order.SupplierId, { transaction });
    await emitIntegrationEvent({
      target: "accounting",
      eventType: "PurchaseOrderUpdated",
      transactionReference: order.orderNumber,
      payload: {
        orderNumber: order.orderNumber,
        supplierId: supplier.id,
        supplierName: supplier.name,
        addedItem: { productId: product.id, sku: product.sku, quantity, unitPrice }
      },
      transaction
    });
  });
  req.flash("success_msg", "Product added to purchase order.");
  res.redirect(`/purchase-orders/${orderId}`);
};

export const updatePurchaseOrderStatus = async (req, res) => {
  const status = String(req.body.status || "");
  const transitions = {
    pending: ["approved", "cancelled"],
    approved: ["ordered", "cancelled"],
    ordered: ["cancelled"]
  };
  const orderId = Number(req.params.id);
  const order = await sequelize.transaction(async transaction => {
    const lockedOrder = await PurchaseOrder.findByPk(orderId, {
      include: [{ model: PurchaseOrderItem, as: "items" }],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!lockedOrder || !transitions[lockedOrder.status]?.includes(status)) throw new Error("That purchase order status transition is not allowed.");
    if (status === "cancelled" && lockedOrder.items.some(item => item.receivedQuantity > 0)) throw new Error("An order with received stock cannot be cancelled.");
    await lockedOrder.update({ status }, { transaction });
    if (status === "approved" || status === "cancelled") {
      const supplier = await Supplier.findByPk(lockedOrder.SupplierId, { transaction });
      await emitIntegrationEvent({
        target: "accounting",
        eventType: status === "approved" ? "PurchaseOrderApproved" : "PurchaseOrderCancelled",
        transactionReference: lockedOrder.orderNumber,
        payload: {
          orderNumber: lockedOrder.orderNumber,
          supplierId: lockedOrder.SupplierId,
          supplierName: supplier.name,
          status,
          items: lockedOrder.items.map(item => ({
            productId: item.ProductId,
            quantity: item.quantity,
            receivedQuantity: item.receivedQuantity,
            unitPrice: formatMoney(item.unitPrice)
          }))
        },
        transaction
      });
    }
    return lockedOrder;
  });
  req.flash("success_msg", "Purchase order status updated.");
  res.redirect(`/purchase-orders/${order.id}`);
};

export const receivePurchaseOrderItem = async (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.body.itemId);
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Received quantity must be a positive whole number.");
  await sequelize.transaction(async transaction => {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order || !["approved", "ordered", "partially_received"].includes(order.status)) {
      throw new Error("Only approved or ordered purchase orders can be received.");
    }
    const item = await PurchaseOrderItem.findOne({
      where: { id: itemId, PurchaseOrderId: orderId },
      include: [Product],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!item || item.receivedQuantity + quantity > item.quantity) throw new Error("Received quantity exceeds the remaining order quantity.");
    await recordMovement({
      productId: item.ProductId,
      movementType: "stock_in",
      quantity,
      remarks: `Received against ${order.orderNumber}`,
      userId: req.user.id,
      transaction
    });
    await item.update({ receivedQuantity: item.receivedQuantity + quantity }, { transaction });
    const invoiceReference = String(req.body.invoiceReference || "").trim();
    if (invoiceReference.length > 120) throw new Error("Supplier invoice reference must be 120 characters or fewer.");
    if (invoiceReference) await order.update({ invoiceReference }, { transaction });
    const supplier = await Supplier.findByPk(order.SupplierId, { transaction });
    await emitIntegrationEvent({
      target: "accounting",
      eventType: "GoodsReceiptRecorded",
      transactionReference: `${order.orderNumber}:${item.id}:${item.receivedQuantity + quantity}`,
      payload: {
        orderNumber: order.orderNumber,
        supplierId: order.SupplierId,
        supplierName: supplier.name,
        invoiceReference: invoiceReference || order.invoiceReference,
        productId: item.ProductId,
        sku: item.Product.sku,
        receivedQuantity: quantity,
        unitCost: formatMoney(item.unitPrice),
        receivedCost: multiplyMoney(item.unitPrice, quantity),
        receivedById: req.user.id
      },
      transaction
    });
    const items = await PurchaseOrderItem.findAll({ where: { PurchaseOrderId: orderId }, transaction });
    const complete = items.every(row => row.receivedQuantity === row.quantity);
    const partial = items.some(row => row.receivedQuantity > 0);
    await order.update({ status: complete ? "received" : partial ? "partially_received" : "ordered" }, { transaction });
  });
  req.flash("success_msg", "Delivery received; inventory has been updated.");
  res.redirect(`/purchase-orders/${orderId}`);
};

export const receiveDeliveryPage = async (req, res) => {
  const order = await PurchaseOrder.findByPk(Number(req.params.id), {
    include: [{ model: PurchaseOrderItem, as: "items", include: [Product] }]
  });
  if (!order) throw new Error("Purchase order not found.");
  const itemId = Number(req.query.item);
  const item = order.items.find(row => row.id === itemId);
  if (!item || item.quantity <= item.receivedQuantity) throw new Error("There is no remaining quantity to receive for this item.");
  renderModule(res, {
    title: `Receive delivery — ${order.orderNumber}`,
    subtitle: `${item.Product.name}: ${item.quantity - item.receivedQuantity} ${item.Product.unit} remaining.`,
    section: "purchase-order-details",
    showForm: true,
    showActions: false,
    formTitle: "Confirm received quantity",
    formAction: `/purchase-orders/${order.id}/receive`,
    fields: makeFields([
      ["itemId", "Purchase order item", "hidden", true],
      ["quantity", "Quantity actually received", "number", true],
      ["invoiceReference", "Supplier invoice reference", "text"]
    ], { itemId: item.id })
  });
};

export const reportsPage = async (req, res) => {
  const report = String(req.query.type || "inventory");
  const reportOptions = [
    { value: "inventory", label: "Current inventory" },
    { value: "low-stock", label: "Low-stock products" },
    { value: "out-of-stock", label: "Out-of-stock products" },
    { value: "movements", label: "Stock movements" },
    { value: "incoming-stock", label: "Incoming stock" },
    { value: "outgoing-stock", label: "Outgoing stock" },
    { value: "suppliers", label: "Suppliers" },
    { value: "purchase-orders", label: "Purchase orders" }
  ];
  if (["movements", "incoming-stock", "outgoing-stock"].includes(report)) {
    const where = {};
    if (report === "incoming-stock") where.movementType = "stock_in";
    if (report === "outgoing-stock") where.movementType = "stock_out";
    if (req.query.from || req.query.to) {
      where.createdAt = {};
      if (req.query.from) where.createdAt[Op.gte] = new Date(`${req.query.from}T00:00:00`);
      if (req.query.to) where.createdAt[Op.lte] = new Date(`${req.query.to}T23:59:59`);
    }
    const movements = await StockMovement.findAll({
      where, include: [Product, { model: User, as: "recordedBy" }], order: [["createdAt", "DESC"]], limit: 1000
    });
    return renderModule(res, {
      title: "Inventory reports",
      subtitle: report === "incoming-stock" ? "Incoming stock report" : report === "outgoing-stock" ? "Outgoing stock report" : "Stock movement report",
      section: "reports",
      columns: ["Date", "Product", "Movement", "Quantity", "Previous", "Updated", "Recorded by"],
      rows: movements.map(item => ({ cells: [item.createdAt.toLocaleString(), item.Product.name, item.movementType.replace("_", " "), item.quantity, item.previousStock, item.updatedStock, item.recordedBy?.name || "CRM integration"] })),
      printable: true,
      filters: [
        { name: "type", label: "Report", type: "select", value: report, options: reportOptions },
        { name: "from", label: "From date", type: "date", value: req.query.from || "" },
        { name: "to", label: "To date", type: "date", value: req.query.to || "" }
      ]
    });
  }
  if (report === "suppliers") {
    const suppliers = await Supplier.findAll({ order: [["name", "ASC"]] });
    return renderModule(res, {
      title: "Inventory reports",
      subtitle: "Supplier report",
      section: "reports",
      columns: ["Supplier", "Contact", "Phone", "Email", "Address", "Status"],
      rows: suppliers.map(item => ({ cells: [item.name, item.contactPerson || "—", item.phone || "—", item.email || "—", item.address || "—", item.status] })),
      printable: true,
      filters: [{ name: "type", label: "Report", type: "select", value: report, options: reportOptions }]
    });
  }
  if (report === "purchase-orders") {
    const orders = await PurchaseOrder.findAll({
      include: [Supplier, { model: PurchaseOrderItem, as: "items" }],
      order: [["createdAt", "DESC"]]
    });
    return renderModule(res, {
      title: "Inventory reports",
      subtitle: "Purchase order report",
      section: "reports",
      columns: ["Order", "Supplier", "Items", "Received units", "Status", "Date"],
      rows: orders.map(order => ({
        cells: [
          order.orderNumber, order.Supplier.name, order.items.length,
          order.items.reduce((sum, item) => sum + item.receivedQuantity, 0),
          order.status.replace("_", " "), order.createdAt.toLocaleDateString()
        ]
      })),
      printable: true,
      filters: [{ name: "type", label: "Report", type: "select", value: report, options: reportOptions }]
    });
  }
  const where = { isActive: true };
  if (report === "low-stock") where.currentStock = { [Op.gt]: 0, [Op.lte]: sequelize.col("minimumStock") };
  if (report === "out-of-stock") where.currentStock = 0;
  const products = await Product.findAll({ where, include: [Category, Supplier], order: [["name", "ASC"]] });
  renderModule(res, {
    title: "Inventory reports",
    subtitle: report === "low-stock" ? "Low-stock report" : report === "out-of-stock" ? "Out-of-stock report" : "Current inventory report",
    section: "reports",
    columns: ["Product", "SKU", "Category", "Supplier", "Unit price", "Stock", "Threshold", "Status"],
    rows: products.map(product => ({ cells: [
      product.name, product.sku, product.Category?.name || "—", product.Supplier?.name || "—",
      Number(product.unitPrice).toFixed(2), product.currentStock, product.minimumStock, stockStatus(product)
    ] })),
    printable: true,
    filters: [{ name: "type", label: "Report", type: "select", value: report, options: reportOptions }]
  });
};
