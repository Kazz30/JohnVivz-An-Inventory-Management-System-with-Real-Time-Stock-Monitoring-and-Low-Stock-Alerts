import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

const commonId = { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true };

export const Role = sequelize.define("Role", {
  id: commonId,
  name: { type: DataTypes.STRING(30), allowNull: false, unique: true }
});

export const User = sequelize.define("User", {
  id: commonId,
  name: { type: DataTypes.STRING(120), allowNull: false },
  email: { type: DataTypes.STRING(190), allowNull: false, unique: true, validate: { isEmail: true } },
  // Null for HR-synced employees: they sign in with their ESS (JVzPay) password,
  // which Inventory never stores.
  password: { type: DataTypes.STRING(255), allowNull: true },
  role: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "staff" },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  hrEmployeeId: { type: DataTypes.STRING(120), allowNull: true },
  // HR job title (text), used only for the position-to-role mapping.
  position: { type: DataTypes.STRING(160), allowNull: true },
  // Last HR employment status seen by the sync (Onboarding, Active, On Leave, ...).
  hrStatus: { type: DataTypes.STRING(30), allowNull: true },
  // True when a manager chose the role by hand; the HR sync then leaves the role alone.
  roleOverridden: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  // Null = never activated: the first successful ESS sign-in activates the account.
  // Set = activated once; a later deactivation (manager or HR) is not undone by signing in.
  activatedAt: { type: DataTypes.DATE, allowNull: true },
  hrSyncedAt: { type: DataTypes.DATE, allowNull: true }
}, { indexes: [
  { name: "idx_users_role_active", fields: ["RoleId", "isActive"] },
  { name: "idx_users_hr_employee_id", fields: ["hrEmployeeId"], unique: true }
] });

// Audit trail of every sign-in attempt (never the password). Also drives rate limiting.
export const LoginAttempt = sequelize.define("LoginAttempt", {
  id: commonId,
  email: { type: DataTypes.STRING(190), allowNull: false },
  ipAddress: { type: DataTypes.STRING(64), allowNull: false },
  mode: { type: DataTypes.STRING(20), allowNull: false },
  outcome: { type: DataTypes.ENUM("success", "failure", "rate_limited", "ess_unavailable"), allowNull: false },
  reason: { type: DataTypes.STRING(60), allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: true }
}, { updatedAt: false, indexes: [
  { name: "idx_login_attempts_email_created", fields: ["email", "createdAt"] },
  { name: "idx_login_attempts_ip_created", fields: ["ipAddress", "createdAt"] }
] });

// Bearer tokens for integration callers. Only a SHA-256 hash is stored; the token itself
// is shown once when it is created. Each token belongs to one system and only works on
// that system's routes.
export const IntegrationToken = sequelize.define("IntegrationToken", {
  id: commonId,
  name: { type: DataTypes.STRING(120), allowNull: false },
  system: { type: DataTypes.ENUM("crm", "accounting"), allowNull: false },
  tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: "uq_integration_tokens_hash" },
  // First characters of the token, safe to show, so people can tell tokens apart.
  tokenPrefix: { type: DataTypes.STRING(24), allowNull: false },
  lastUsedAt: { type: DataTypes.DATE, allowNull: true },
  revokedAt: { type: DataTypes.DATE, allowNull: true }
});

export const Category = sequelize.define("Category", {
  id: commonId,
  name: { type: DataTypes.STRING(120), allowNull: false, unique: true },
  description: { type: DataTypes.TEXT, allowNull: true }
});

export const Supplier = sequelize.define("Supplier", {
  id: commonId,
  name: { type: DataTypes.STRING(160), allowNull: false },
  contactPerson: { type: DataTypes.STRING(120), allowNull: true },
  phone: { type: DataTypes.STRING(40), allowNull: true },
  email: { type: DataTypes.STRING(190), allowNull: true, validate: { isEmail: true } },
  address: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.ENUM("active", "inactive"), allowNull: false, defaultValue: "active" }
}, { indexes: [{ name: "idx_suppliers_status_name", fields: ["status", "name"] }] });

export const Product = sequelize.define("Product", {
  id: commonId,
  name: { type: DataTypes.STRING(180), allowNull: false },
  sku: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  description: { type: DataTypes.TEXT, allowNull: true },
  unitPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0, validate: { min: 0 } },
  currentStock: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: { min: 0 } },
  minimumStock: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: { min: 0 } },
  unit: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "unit" },
  imagePath: { type: DataTypes.STRING(255), allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
}, { indexes: [{ name: "idx_products_active_stock", fields: ["isActive", "currentStock"] }] });

export const Inventory = sequelize.define("Inventory", {
  id: commonId,
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: { min: 0 } },
  location: { type: DataTypes.STRING(120), allowNull: true }
});

export const PurchaseOrder = sequelize.define("PurchaseOrder", {
  id: commonId,
  orderNumber: { type: DataTypes.STRING(40), allowNull: false, unique: true },
  status: {
    type: DataTypes.ENUM("pending", "approved", "ordered", "partially_received", "received", "cancelled"),
    allowNull: false,
    defaultValue: "pending"
  },
  orderDate: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  notes: { type: DataTypes.TEXT, allowNull: true },
  invoiceReference: { type: DataTypes.STRING(120), allowNull: true }
}, { indexes: [{ name: "idx_purchase_orders_status_created", fields: ["status", "createdAt"] }] });

export const PurchaseOrderItem = sequelize.define("PurchaseOrderItem", {
  id: commonId,
  quantity: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
  receivedQuantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: { min: 0 } },
  unitPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0, validate: { min: 0 } }
}, { indexes: [{ name: "idx_purchase_order_items_order_product", fields: ["PurchaseOrderId", "ProductId"] }] });

export const StockMovement = sequelize.define("StockMovement", {
  id: commonId,
  movementType: { type: DataTypes.ENUM("stock_in", "stock_out", "adjustment"), allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
  previousStock: { type: DataTypes.INTEGER, allowNull: false },
  updatedStock: { type: DataTypes.INTEGER, allowNull: false },
  remarks: { type: DataTypes.TEXT, allowNull: true },
  externalReference: { type: DataTypes.STRING(190), allowNull: true },
  source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "manual" }
}, { indexes: [
  { name: "idx_stock_movements_product_created", fields: ["ProductId", "createdAt"] },
  { name: "idx_stock_movements_type_created", fields: ["movementType", "createdAt"] }
] });

export const StockReservation = sequelize.define("StockReservation", {
  id: commonId,
  orderReference: { type: DataTypes.STRING(120), allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
  status: { type: DataTypes.ENUM("active", "released", "consumed"), allowNull: false, defaultValue: "active" }
}, { indexes: [
  { name: "idx_stock_reservations_order_product", unique: true, fields: ["orderReference", "ProductId"] },
  { name: "idx_stock_reservations_product_status", fields: ["ProductId", "status"] }
] });

export const IntegrationInbox = sequelize.define("IntegrationInbox", {
  id: commonId,
  eventId: { type: DataTypes.STRING(120), allowNull: false, unique: true },
  source: { type: DataTypes.STRING(40), allowNull: false },
  eventType: { type: DataTypes.STRING(80), allowNull: false },
  transactionReference: { type: DataTypes.STRING(190), allowNull: true },
  payload: { type: DataTypes.TEXT("long"), allowNull: false },
  status: { type: DataTypes.ENUM("processed", "rejected"), allowNull: false },
  response: { type: DataTypes.TEXT("long"), allowNull: true }
}, { indexes: [
  { name: "idx_integration_inbox_source_created", fields: ["source", "createdAt"] },
  { name: "idx_integration_inbox_business_reference", unique: true, fields: ["source", "eventType", "transactionReference"] }
] });

export const IntegrationOutbox = sequelize.define("IntegrationOutbox", {
  id: commonId,
  eventId: { type: DataTypes.UUID, allowNull: false, unique: true, defaultValue: DataTypes.UUIDV4 },
  target: { type: DataTypes.ENUM("crm", "accounting"), allowNull: false, defaultValue: "crm" },
  eventType: { type: DataTypes.STRING(80), allowNull: false },
  transactionReference: { type: DataTypes.STRING(190), allowNull: true },
  payload: { type: DataTypes.TEXT("long"), allowNull: false },
  publishedAt: { type: DataTypes.DATE, allowNull: true }
});

export const LowStockAlert = sequelize.define("LowStockAlert", {
  id: commonId,
  currentStock: { type: DataTypes.INTEGER, allowNull: false },
  minimumStock: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.ENUM("active", "resolved"), allowNull: false, defaultValue: "active" },
  resolvedAt: { type: DataTypes.DATE, allowNull: true }
}, { indexes: [{ name: "idx_low_stock_alert_product_status", fields: ["ProductId", "status"] }] });

export const Notification = sequelize.define("Notification", {
  id: commonId,
  message: { type: DataTypes.STRING(500), allowNull: false },
  readAt: { type: DataTypes.DATE, allowNull: true }
}, { indexes: [{ name: "idx_notifications_user_read_created", fields: ["UserId", "readAt", "createdAt"] }] });

Role.hasMany(User, { foreignKey: { name: "RoleId", allowNull: true }, onDelete: "RESTRICT" });
User.belongsTo(Role, { foreignKey: { name: "RoleId", allowNull: true } });
Category.hasMany(Product, { foreignKey: { allowNull: true }, onDelete: "SET NULL" });
Product.belongsTo(Category, { foreignKey: { allowNull: true } });
Supplier.hasMany(Product, { foreignKey: { allowNull: true }, onDelete: "SET NULL" });
Product.belongsTo(Supplier, { foreignKey: { allowNull: true } });
Supplier.hasMany(PurchaseOrder, { foreignKey: { allowNull: false }, onDelete: "RESTRICT" });
PurchaseOrder.belongsTo(Supplier, { foreignKey: { allowNull: false } });
User.hasMany(PurchaseOrder, { as: "createdOrders", foreignKey: { name: "createdById", allowNull: false } });
PurchaseOrder.belongsTo(User, { as: "createdBy", foreignKey: { name: "createdById", allowNull: false } });
PurchaseOrder.hasMany(PurchaseOrderItem, { as: "items", foreignKey: { allowNull: false }, onDelete: "CASCADE" });
PurchaseOrderItem.belongsTo(PurchaseOrder, { foreignKey: { allowNull: false } });
Product.hasMany(PurchaseOrderItem, { foreignKey: { allowNull: false }, onDelete: "RESTRICT" });
PurchaseOrderItem.belongsTo(Product, { foreignKey: { allowNull: false } });
Product.hasOne(Inventory, { foreignKey: { allowNull: false }, onDelete: "CASCADE" });
Inventory.belongsTo(Product, { foreignKey: { allowNull: false } });
Product.hasMany(StockMovement, { foreignKey: { allowNull: false }, onDelete: "RESTRICT" });
StockMovement.belongsTo(Product, { foreignKey: { allowNull: false } });
User.hasMany(StockMovement, { foreignKey: { name: "recordedById", allowNull: true }, onDelete: "RESTRICT" });
StockMovement.belongsTo(User, { as: "recordedBy", foreignKey: { name: "recordedById", allowNull: true } });
Product.hasMany(StockReservation, { foreignKey: { allowNull: false }, onDelete: "RESTRICT" });
StockReservation.belongsTo(Product, { foreignKey: { allowNull: false } });
Product.hasMany(LowStockAlert, { foreignKey: { allowNull: false }, onDelete: "CASCADE" });
LowStockAlert.belongsTo(Product, { foreignKey: { allowNull: false } });
Product.hasMany(Notification, { foreignKey: { allowNull: true }, onDelete: "SET NULL" });
Notification.belongsTo(Product, { foreignKey: { allowNull: true } });
User.hasMany(Notification, { foreignKey: { allowNull: false }, onDelete: "CASCADE" });
Notification.belongsTo(User, { foreignKey: { allowNull: false } });

export { sequelize };
