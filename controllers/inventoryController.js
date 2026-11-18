import { Op } from "sequelize";
import {
  Category, Inventory, LowStockAlert, Notification, Product, PurchaseOrder, PurchaseOrderItem,
  StockMovement, StockReservation, Supplier, User, Role, sequelize
} from "../models/index.js";
import { emitIntegrationEvent, recordMovement } from "../services/inventoryService.js";
import { makeFields, renderModule } from "./viewHelpers.js";
import { canRecordMovement } from "../services/permissions.js";
import { formatMoney, parseMoney } from "../services/money.js";

const stockStatus = product => product.currentStock <= 0
  ? "Out of stock"
  : product.currentStock <= product.minimumStock ? "Low stock" : "In stock";

const productFields = async record => {
  const [categories, suppliers] = await Promise.all([
    Category.findAll({ order: [["name", "ASC"]] }),
    Supplier.findAll({ where: { status: "active" }, order: [["name", "ASC"]] })
  ]);
  return makeFields([
    ["name", "Product name", "text", true],
    ["sku", "SKU / Barcode", "text", true],
    ["description", "Description", "textarea"],
    ["CategoryId", "Category", "select", false, [{ value: "", label: "Uncategorized" }, ...categories.map(item => ({ value: item.id, label: item.name }))]],
    ["SupplierId", "Supplier", "select", false, [{ value: "", label: "No supplier" }, ...suppliers.map(item => ({ value: item.id, label: item.name }))]],
    ["unitPrice", "Unit price", "number", true],
    ["minimumStock", "Minimum stock threshold", "number", true],
    ["unit", "Unit of measurement", "text", true],
    ["imagePath", "Product image URL (optional)", "url"]
  ], record || {});
};

const entityRows = (items, cells) => items.map(item => ({ id: item.id, cells: cells(item) }));

export const productsPage = async (req, res) => {
  const search = String(req.query.search || "").trim();
  const where = { isActive: true };
  if (search) where[Op.or] = [{ name: { [Op.like]: `%${search}%` } }, { sku: { [Op.like]: `%${search}%` } }];
  const products = await Product.findAll({
    where, include: [Category, Supplier], order: [["name", "ASC"]]
  });
  let visible = products;
  if (req.query.status) visible = products.filter(product => stockStatus(product) === req.query.status);
  if (req.query.category) visible = visible.filter(product => String(product.CategoryId) === String(req.query.category));
  const categories = await Category.findAll({ order: [["name", "ASC"]] });
  renderModule(res, {
    title: "Products",
    subtitle: "Manage the products tracked in your inventory.",
    section: "products",
    columns: ["Product", "SKU", "Category", "Supplier", "Unit price", "Current stock", "Status"],
    rows: visible.map(product => ({
      id: product.id,
      href: `/products/${product.id}`,
      canArchive: product.currentStock === 0,
      cells: [
        product.name, product.sku, product.Category?.name || "—", product.Supplier?.name || "—",
        Number(product.unitPrice).toFixed(2), `${product.currentStock} ${product.unit}`, stockStatus(product)
      ]
    })),
    showForm: req.user.Role.name === "manager",
    formTitle: "Add product",
    formAction: "/products",
    fields: [
      ...(await productFields()),
      ...makeFields([["initialStock", "Opening stock", "number", true]])
    ],
    filters: [
      { name: "search", label: "Search name or SKU", type: "search", value: search },
      { name: "category", label: "Category", type: "select", value: req.query.category || "", options: [{ value: "", label: "All categories" }, ...categories.map(category => ({ value: category.id, label: category.name }))] },
      { name: "status", label: "Stock status", type: "select", value: req.query.status || "", options: ["", "In stock", "Low stock", "Out of stock"].map(value => ({ value, label: value || "All statuses" })) }
    ]
  });
};

export const createProduct = async (req, res) => {
  const name = String(req.body.name || "").trim();
  const sku = String(req.body.sku || "").trim();
  const initialStock = Number(req.body.initialStock || 0);
  const unitPrice = parseMoney(req.body.unitPrice);
  const minimumStock = Number(req.body.minimumStock);
  if (!name || !sku || !Number.isInteger(initialStock) || initialStock < 0 ||
      unitPrice === null || !Number.isInteger(minimumStock) || minimumStock < 0) {
    throw new Error("Provide a name, SKU, non-negative price and threshold, and a valid initial stock quantity.");
  }
  await sequelize.transaction(async transaction => {
    const product = await Product.create({
      name, sku, description: req.body.description || null,
      CategoryId: req.body.CategoryId ? Number(req.body.CategoryId) : null,
      SupplierId: req.body.SupplierId ? Number(req.body.SupplierId) : null,
      unitPrice, minimumStock, unit: String(req.body.unit || "unit").trim(),
      imagePath: req.body.imagePath || null, currentStock: 0
    }, { transaction });
    await Inventory.create({ ProductId: product.id, quantity: 0 }, { transaction });
    await emitIntegrationEvent({
      eventType: "ProductCreated",
      transactionReference: `product:${product.id}`,
      payload: {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        price: formatMoney(product.unitPrice),
        unit: product.unit
      },
      transaction
    });
    if (initialStock > 0) await recordMovement({
      productId: product.id, movementType: "stock_in", quantity: initialStock,
      remarks: "Opening stock", userId: req.user.id, transaction
    });
  });
  req.flash("success_msg", "Product created.");
  res.redirect("/products");
};

export const editProductPage = async (req, res) => {
  const product = await Product.findByPk(Number(req.params.id));
  if (!product || !product.isActive) throw new Error("Product not found.");
  renderModule(res, {
    title: `Edit ${product.name}`,
    subtitle: "Stock quantities must be changed through a stock movement.",
    section: "products",
    showForm: true,
    showActions: false,
    formTitle: "Product details",
    formAction: `/products/${product.id}/update`,
    fields: await productFields(product.toJSON())
  });
};

export const productDetailsPage = async (req, res) => {
  const [product, reservedStock] = await Promise.all([Product.findByPk(Number(req.params.id), {
    include: [Category, Supplier, Inventory]
  }), StockReservation.sum("quantity", { where: { ProductId: Number(req.params.id), status: "active" } })]);
  if (!product) throw new Error("Product not found.");
  const reservedQuantity = Number(reservedStock || 0);
  const movements = await StockMovement.findAll({
    where: { ProductId: product.id },
    include: [{ model: User, as: "recordedBy" }],
    order: [["createdAt", "DESC"]],
    limit: 30
  });
  renderModule(res, {
    title: product.name,
    subtitle: `${product.sku} · ${stockStatus(product)} · ${product.currentStock} ${product.unit} on hand`,
    section: "product-details",
    columns: ["Date", "Movement", "Quantity", "Before", "After", "Recorded by", "Remarks"],
    rows: movements.map(movement => ({
      cells: [movement.createdAt.toLocaleString(), movement.movementType.replace("_", " "), movement.quantity, movement.previousStock, movement.updatedStock, movement.recordedBy?.name || "CRM integration", movement.remarks || "—"]
    })),
    details: [
      { label: "Category", value: product.Category?.name || "Uncategorized" },
      { label: "Supplier", value: product.Supplier?.name || "—" },
      { label: "Unit price", value: Number(product.unitPrice).toFixed(2) },
      { label: "Physical stock", value: `${product.Inventory?.quantity ?? 0} ${product.unit}` },
      { label: "Reserved stock", value: `${reservedQuantity} ${product.unit}` },
      { label: "Available stock", value: `${(product.Inventory?.quantity ?? 0) - reservedQuantity} ${product.unit}` },
      { label: "Minimum stock", value: product.minimumStock },
      { label: "Description", value: product.description || "—" }
    ],
    summaryLines: [{ label: "Edit details", href: `/products/${product.id}/edit` }]
  });
};

export const updateProduct = async (req, res) => {
  const product = await Product.findByPk(Number(req.params.id));
  if (!product || !product.isActive) throw new Error("Product not found.");
  const unitPrice = parseMoney(req.body.unitPrice);
  const minimumStock = Number(req.body.minimumStock);
  if (!String(req.body.name || "").trim() || !String(req.body.sku || "").trim() ||
      unitPrice === null || !Number.isInteger(minimumStock) || minimumStock < 0) {
    throw new Error("Provide a valid product name, SKU, price, and minimum stock threshold.");
  }
  const previousPrice = formatMoney(product.unitPrice);
  const updates = {
    name: String(req.body.name).trim(), sku: String(req.body.sku).trim(),
    description: req.body.description || null,
    CategoryId: req.body.CategoryId ? Number(req.body.CategoryId) : null,
    SupplierId: req.body.SupplierId ? Number(req.body.SupplierId) : null,
    unitPrice, minimumStock, unit: String(req.body.unit || "unit").trim(),
    imagePath: req.body.imagePath || null
  };
  await sequelize.transaction(async transaction => {
    await product.update(updates, { transaction });
    const payload = {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      price: formatMoney(product.unitPrice),
      unit: product.unit
    };
    await emitIntegrationEvent({
      eventType: "ProductUpdated",
      transactionReference: `product:${product.id}:${product.updatedAt.getTime()}`,
      payload,
      transaction
    });
    if (previousPrice !== unitPrice) {
      await emitIntegrationEvent({
        eventType: "ProductPriceUpdated",
        transactionReference: `price:${product.id}:${product.updatedAt.getTime()}`,
        payload: { ...payload, previousPrice, newPrice: formatMoney(product.unitPrice) },
        transaction
      });
    }
  });
  req.flash("success_msg", "Product details updated.");
  res.redirect("/products");
};

export const archiveProduct = async (req, res) => {
  const product = await Product.findByPk(Number(req.params.id));
  if (!product) throw new Error("Product not found.");
  if (product.currentStock !== 0) throw new Error("A product can only be archived after its stock reaches zero.");
  const openOrderItem = await PurchaseOrderItem.findOne({
    where: { ProductId: product.id },
    include: [{ model: PurchaseOrder, where: { status: { [Op.in]: ["pending", "approved", "ordered", "partially_received"] } } }]
  });
  if (openOrderItem) throw new Error("This product is part of an open purchase order and cannot be archived yet.");
  await sequelize.transaction(async transaction => {
    await product.update({ isActive: false }, { transaction });
    await emitIntegrationEvent({
      eventType: "ProductUnavailable",
      transactionReference: `archive:${product.id}:${Date.now()}`,
      payload: { productId: product.id, sku: product.sku, reason: "archived" },
      transaction
    });
    await LowStockAlert.update(
      { status: "resolved", resolvedAt: new Date() },
      { where: { ProductId: product.id, status: "active" }, transaction }
    );
  });
  req.flash("success_msg", "Product archived. Its movement history was preserved.");
  res.redirect("/products");
};

export const categoriesPage = async (req, res) => {
  const search = String(req.query.search || "").trim();
  const categories = await Category.findAll({
    where: search ? { name: { [Op.like]: `%${search}%` } } : {},
    include: [{ model: Product, attributes: ["id"] }],
    order: [["name", "ASC"]]
  });
  renderModule(res, {
    title: "Categories",
    subtitle: "Organize products into inventory categories.",
    section: "categories",
    columns: ["Category", "Description", "Products"],
    rows: categories.map(category => ({
      id: category.id,
      href: req.user.Role.name === "manager" ? `/categories/${category.id}/edit` : "",
      canDelete: category.Products.length === 0,
      cells: [category.name, category.description || "—", category.Products.length]
    })),
    showForm: req.user.Role.name === "manager",
    formTitle: "Add category",
    formAction: "/categories",
    fields: makeFields([["name", "Category name", "text", true], ["description", "Description", "textarea"]]),
    filters: [{ name: "search", label: "Search categories", type: "search", value: search }]
  });
};

export const createCategory = async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) throw new Error("Category name is required.");
  await Category.create({ name, description: req.body.description || null });
  req.flash("success_msg", "Category created.");
  res.redirect("/categories");
};

export const editCategoryPage = async (req, res) => {
  const category = await Category.findByPk(Number(req.params.id));
  if (!category) throw new Error("Category not found.");
  renderModule(res, {
    title: `Edit ${category.name}`,
    section: "categories",
    showForm: req.user.Role.name === "manager",
    showActions: false,
    formTitle: "Category details",
    formAction: `/categories/${category.id}/update`,
    fields: makeFields([["name", "Category name", "text", true], ["description", "Description", "textarea"]], category.toJSON())
  });
};

export const updateCategory = async (req, res) => {
  const category = await Category.findByPk(Number(req.params.id));
  const name = String(req.body.name || "").trim();
  if (!category || !name) throw new Error("Category not found or name is empty.");
  await category.update({ name, description: req.body.description || null });
  req.flash("success_msg", "Category updated.");
  res.redirect("/categories");
};

export const deleteCategory = async (req, res) => {
  const category = await Category.findByPk(Number(req.params.id), { include: [{ model: Product, attributes: ["id"] }] });
  if (!category) throw new Error("Category not found.");
  if (category.Products.length) throw new Error("This category still has products assigned to it.");
  await category.destroy();
  req.flash("success_msg", "Category deleted.");
  res.redirect("/categories");
};

export const suppliersPage = async (req, res) => {
  const search = String(req.query.search || "").trim();
  const suppliers = await Supplier.findAll({
    where: search ? { [Op.or]: [{ name: { [Op.like]: `%${search}%` } }, { email: { [Op.like]: `%${search}%` } }] } : {},
    order: [["name", "ASC"]]
  });
  renderModule(res, {
    title: "Suppliers",
    subtitle: "Manage supplier contact details and status.",
    section: "suppliers",
    columns: ["Supplier", "Contact", "Phone", "Email", "Status"],
    rows: entityRows(suppliers, supplier => [supplier.name, supplier.contactPerson || "—", supplier.phone || "—", supplier.email || "—", supplier.status]),
    showForm: req.user.Role.name === "manager",
    formTitle: "Add supplier",
    formAction: "/suppliers",
    fields: makeFields([
      ["name", "Supplier name", "text", true],
      ["contactPerson", "Contact person", "text"],
      ["phone", "Contact number", "tel"],
      ["email", "Email address", "email"],
      ["address", "Address", "textarea"]
    ]),
    filters: [{ name: "search", label: "Search suppliers", type: "search", value: search }]
  });
};

export const createSupplier = async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) throw new Error("Supplier name is required.");
  await Supplier.create({
    name, contactPerson: req.body.contactPerson || null, phone: req.body.phone || null,
    email: req.body.email || null, address: req.body.address || null
  });
  req.flash("success_msg", "Supplier created.");
  res.redirect("/suppliers");
};

export const editSupplierPage = async (req, res) => {
  const supplier = await Supplier.findByPk(Number(req.params.id));
  if (!supplier) throw new Error("Supplier not found.");
  renderModule(res, {
    title: `Edit ${supplier.name}`,
    section: "suppliers",
    showForm: true,
    showActions: false,
    formTitle: "Supplier details",
    formAction: `/suppliers/${supplier.id}/update`,
    fields: makeFields([
      ["name", "Supplier name", "text", true],
      ["contactPerson", "Contact person", "text"],
      ["phone", "Contact number", "tel"],
      ["email", "Email address", "email"],
      ["address", "Address", "textarea"]
    ], supplier.toJSON())
  });
};

export const updateSupplier = async (req, res) => {
  const supplier = await Supplier.findByPk(Number(req.params.id));
  if (!supplier || !String(req.body.name || "").trim()) throw new Error("Supplier not found or name is empty.");
  await supplier.update({
    name: String(req.body.name).trim(), contactPerson: req.body.contactPerson || null,
    phone: req.body.phone || null, email: req.body.email || null, address: req.body.address || null
  });
  req.flash("success_msg", "Supplier updated.");
  res.redirect("/suppliers");
};

export const archiveSupplier = async (req, res) => {
  const supplier = await Supplier.findByPk(Number(req.params.id));
  if (!supplier) throw new Error("Supplier not found.");
  await supplier.update({ status: supplier.status === "active" ? "inactive" : "active" });
  req.flash("success_msg", `Supplier ${supplier.status}.`);
  res.redirect("/suppliers");
};

export const inventoryPage = async (req, res) => {
  const products = await Product.findAll({
    where: { isActive: true }, include: [Category, Inventory], order: [["name", "ASC"]]
  });
  const reservationRows = products.length ? await StockReservation.findAll({
    attributes: ["ProductId", [sequelize.fn("SUM", sequelize.col("quantity")), "reserved"]],
    where: { status: "active", ProductId: { [Op.in]: products.map(product => product.id) } },
    group: ["ProductId"],
    raw: true
  }) : [];
  const reservedByProduct = new Map(reservationRows.map(row => [Number(row.ProductId), Number(row.reserved)]));
  renderModule(res, {
    title: "Inventory",
    subtitle: "Current quantities and stock status.",
    section: "inventory",
    columns: ["Product", "SKU", "Category", "On hand", "Reserved", "Available", "Minimum", "Status"],
    rows: entityRows(products, product => [
      product.name, product.sku, product.Category?.name || "—",
      `${product.Inventory?.quantity ?? 0} ${product.unit}`,
      `${reservedByProduct.get(product.id) || 0} ${product.unit}`,
      `${(product.Inventory?.quantity ?? 0) - (reservedByProduct.get(product.id) || 0)} ${product.unit}`,
      product.minimumStock, stockStatus(product)
    ]),
    actions: [
      { href: "/inventory/stock-in", label: "＋ Stock in", type: "stock_in" },
      { href: "/inventory/stock-out", label: "− Stock out", type: "stock_out" },
      { href: "/inventory/adjustment", label: "Adjust stock", type: "adjustment" }
    ].filter(action => canRecordMovement(req.user, action.type))
  });
};

export const movementFormPage = async (req, res) => {
  const type = req.params.type;
  if (!["stock-in", "stock-out", "adjustment"].includes(type)) throw new Error("Unknown movement type.");
  const products = await Product.findAll({ where: { isActive: true }, order: [["name", "ASC"]] });
  const title = type === "stock-in" ? "Record stock in" : type === "stock-out" ? "Record stock out" : "Adjust stock";
  renderModule(res, {
    title,
    subtitle: type === "adjustment" ? "Enter the verified new on-hand quantity." : "All changes are recorded in stock movement history.",
    section: "inventory",
    showForm: true,
    showActions: false,
    formTitle: title,
    formAction: `/inventory/movements/${type}`,
    fields: makeFields([
      ["productId", "Product", "select", true, [{ value: "", label: "Select a product" }, ...products.map(product => ({ value: product.id, label: `${product.name} (${product.currentStock} ${product.unit})` }))]],
      ["quantity", type === "adjustment" ? "Counted stock quantity" : "Quantity", "number", true],
      ["remarks", "Remarks", "textarea"]
    ])
  });
};

export const createMovement = async (req, res) => {
  const type = req.params.type;
  if (!["stock-in", "stock-out", "adjustment"].includes(type)) throw new Error("Unknown movement type.");
  const movementType = type === "stock-in" ? "stock_in" : type === "stock-out" ? "stock_out" : "adjustment";
  if (!canRecordMovement(req.user, movementType)) {
    const error = new Error("Your role is not allowed to record this stock movement.");
    error.status = 403;
    throw error;
  }
  const quantity = Number(req.body.quantity);
  const productId = Number(req.body.productId);
  if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 0 ||
      (movementType !== "adjustment" && quantity < 1)) {
    throw new Error("Select a product and enter a valid quantity.");
  }
  await sequelize.transaction(transaction => recordMovement({
    productId, movementType, quantity, remarks: req.body.remarks, userId: req.user.id, transaction
  }));
  req.flash("success_msg", "Stock movement recorded and inventory updated.");
  res.redirect("/inventory");
};

export const movementsPage = async (req, res) => {
  const where = {};
  if (req.query.product) where.ProductId = Number(req.query.product);
  if (req.query.type && ["stock_in", "stock_out", "adjustment"].includes(req.query.type)) where.movementType = req.query.type;
  if (req.query.from || req.query.to) {
    where.createdAt = {};
    if (req.query.from) where.createdAt[Op.gte] = new Date(`${req.query.from}T00:00:00`);
    if (req.query.to) where.createdAt[Op.lte] = new Date(`${req.query.to}T23:59:59`);
  }
  const [movements, products] = await Promise.all([
    StockMovement.findAll({ where, include: [Product, { model: User, as: "recordedBy" }], order: [["createdAt", "DESC"]], limit: 500 }),
    Product.findAll({ attributes: ["id", "name"], order: [["name", "ASC"]] })
  ]);
  renderModule(res, {
    title: "Stock movements",
    subtitle: "Append-only history of every inventory change.",
    section: "movements",
    columns: ["Date", "Product", "Type", "Quantity", "Before", "After", "Recorded by", "Remarks"],
    rows: movements.map(movement => ({
      id: movement.id,
      href: `/movements/${movement.id}`,
      cells: [
        movement.createdAt.toLocaleString(), movement.Product.name, movement.movementType.replace("_", " "),
        movement.quantity, movement.previousStock, movement.updatedStock, movement.recordedBy?.name || "CRM integration", movement.remarks || "—"
      ]
    })),
    filters: [
      { name: "product", label: "Product", type: "select", value: req.query.product || "", options: [{ value: "", label: "All products" }, ...products.map(product => ({ value: product.id, label: product.name }))] },
      { name: "type", label: "Movement type", type: "select", value: req.query.type || "", options: ["", "stock_in", "stock_out", "adjustment"].map(value => ({ value, label: value || "All types" })) },
      { name: "from", label: "From date", type: "date", value: req.query.from || "" },
      { name: "to", label: "To date", type: "date", value: req.query.to || "" }
    ],
    emptyText: "No movements match these filters."
  });
};

export const movementDetailsPage = async (req, res) => {
  const movement = await StockMovement.findByPk(Number(req.params.id), {
    include: [Product, { model: User, as: "recordedBy" }]
  });
  if (!movement) throw new Error("Stock movement not found.");
  renderModule(res, {
    title: `Movement #${movement.id}`,
    subtitle: "Inventory transaction history is immutable.",
    section: "movements",
    showActions: false,
    details: [
      { label: "Product", value: movement.Product.name },
      { label: "Movement type", value: movement.movementType.replace("_", " ") },
      { label: "Quantity changed", value: movement.quantity },
      { label: "Previous stock", value: movement.previousStock },
      { label: "Updated stock", value: movement.updatedStock },
      { label: "Recorded by", value: movement.recordedBy?.name || "CRM integration" },
      { label: "Date and time", value: movement.createdAt.toLocaleString() },
      { label: "Remarks", value: movement.remarks || "—" }
    ],
    summaryLines: [{ label: "View product", href: `/products/${movement.ProductId}` }]
  });
};

export const alertsPage = async (req, res) => {
  const alerts = await LowStockAlert.findAll({
    where: { status: req.query.status === "resolved" ? "resolved" : "active" },
    include: [Product], order: [["createdAt", "DESC"]], limit: 500
  });
  renderModule(res, {
    title: "Low-stock alerts",
    subtitle: "Active alerts clear automatically after replenishment above threshold.",
    section: "alerts",
    columns: ["Product", "Current stock", "Threshold", "Status", "Alert date", "Resolved"],
    rows: alerts.map(alert => ({
      id: alert.id,
      href: alert.ProductId ? `/products/${alert.ProductId}` : "",
      cells: [
        alert.Product?.name || "Archived product", alert.currentStock, alert.minimumStock,
        alert.status, alert.createdAt.toLocaleString(), alert.resolvedAt?.toLocaleString() || "—"
      ]
    })),
    filters: [{ name: "status", label: "Alert status", type: "select", value: req.query.status || "active", options: [{ value: "active", label: "Active alerts" }, { value: "resolved", label: "Resolved alerts" }] }]
  });
};

export const notificationsPage = async (req, res) => {
  const notifications = await Notification.findAll({
    where: { UserId: req.user.id }, include: [Product], order: [["createdAt", "DESC"]], limit: 500
  });
  renderModule(res, {
    title: "Notifications",
    subtitle: "Unread notifications: " + notifications.filter(item => !item.readAt).length,
    section: "notifications",
    columns: ["Notification", "Product", "Date", "Status"],
    rows: notifications.map(notification => ({
      id: notification.id,
      href: notification.ProductId ? `/products/${notification.ProductId}` : "",
      cells: [
        notification.message, notification.Product?.name || "—", notification.createdAt.toLocaleString(), notification.readAt ? "Read" : "Unread"
      ]
    })),
    bulkAction: "/notifications/read-all"
  });
};

export const markAllNotificationsRead = async (req, res) => {
  await Notification.update({ readAt: new Date() }, { where: { UserId: req.user.id, readAt: null } });
  req.flash("success_msg", "All notifications marked as read.");
  res.redirect("/notifications");
};

export const markNotificationRead = async (req, res) => {
  const notification = await Notification.findOne({ where: { id: Number(req.params.id), UserId: req.user.id } });
  if (!notification) throw new Error("Notification not found.");
  await notification.update({ readAt: new Date() });
  req.flash("success_msg", "Notification marked as read.");
  res.redirect("/notifications");
};
