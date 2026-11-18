import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const migrateLegacyUsers = async () => {
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable("Users");
  if (!table.RoleId) {
    await queryInterface.addColumn("Users", "RoleId", {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "Roles", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT"
    });
  }
  if (!table.isActive) {
    await queryInterface.addColumn("Users", "isActive", {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    });
  }

  await queryInterface.changeColumn("Roles", "name", {
    type: DataTypes.STRING(30),
    allowNull: false
  });
  await queryInterface.changeColumn("Users", "role", {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: "staff"
  });
  await sequelize.query("UPDATE `Roles` SET `name` = 'manager' WHERE `name` = 'admin'");
  await sequelize.query("UPDATE `Users` SET `role` = 'manager' WHERE `role` = 'admin'");
  await sequelize.query("UPDATE `Users` SET `role` = 'staff' WHERE `role` NOT IN ('manager', 'supervisor', 'staff')");

  const RoleModel = sequelize.models.Role;
  await Promise.all(["manager", "supervisor", "staff"].map(name =>
    RoleModel.findOrCreate({ where: { name } })
  ));
  await sequelize.query(
    "UPDATE `Users` SET `RoleId` = (SELECT `id` FROM `Roles` WHERE `name` = `Users`.`role` LIMIT 1) WHERE `RoleId` IS NULL"
  );
};

export const ensureApplicationIndexes = async () => {
  const queryInterface = sequelize.getQueryInterface();
  const indexes = [
    ["Users", "idx_users_role_active", ["RoleId", "isActive"]],
    ["Suppliers", "idx_suppliers_status_name", ["status", "name"]],
    ["Products", "idx_products_active_stock", ["isActive", "currentStock"]],
    ["PurchaseOrders", "idx_purchase_orders_status_created", ["status", "createdAt"]],
    ["PurchaseOrderItems", "idx_purchase_order_items_order_product", ["PurchaseOrderId", "ProductId"]],
    ["StockMovements", "idx_stock_movements_product_created", ["ProductId", "createdAt"]],
    ["StockMovements", "idx_stock_movements_type_created", ["movementType", "createdAt"]],
    ["StockMovements", "idx_stock_movements_external_reference", ["externalReference"], true],
    ["IntegrationOutboxes", "idx_integration_outbox_pending_created", ["target", "publishedAt", "createdAt"]],
    ["LowStockAlerts", "idx_low_stock_alert_product_status", ["ProductId", "status"]],
    ["Notifications", "idx_notifications_user_read_created", ["UserId", "readAt", "createdAt"]],
    ["Sessions", "idx_sessions_expires_at", ["expiresAt"]]
  ];

  for (const [table, name, fields, unique = false] of indexes) {
    const existing = await queryInterface.showIndex(table);
    if (!existing.some(index => index.name === name)) {
      await queryInterface.addIndex(table, fields, { name, unique });
    }
  }
};

export const ensureIntegrationSchema = async () => {
  const queryInterface = sequelize.getQueryInterface();
  const purchaseOrderColumns = await queryInterface.describeTable("PurchaseOrders");
  if (!purchaseOrderColumns.invoiceReference) {
    await queryInterface.addColumn("PurchaseOrders", "invoiceReference", {
      type: DataTypes.STRING(120),
      allowNull: true
    });
  }

  const movementColumns = await queryInterface.describeTable("StockMovements");
  if (!movementColumns.externalReference) {
    await queryInterface.addColumn("StockMovements", "externalReference", {
      type: DataTypes.STRING(190),
      allowNull: true
    });
  }
  if (!movementColumns.source) {
    await queryInterface.addColumn("StockMovements", "source", {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: "manual"
    });
  }

  const outboxColumns = await queryInterface.describeTable("IntegrationOutboxes");
  if (!outboxColumns.target) {
    await queryInterface.addColumn("IntegrationOutboxes", "target", {
      type: DataTypes.ENUM("crm", "accounting"),
      allowNull: false,
      defaultValue: "crm"
    });
  }

  await queryInterface.changeColumn("StockMovements", "recordedById", {
    type: DataTypes.INTEGER,
    allowNull: true
  });

  const [recordedByForeignKeys] = await sequelize.query(
    "SELECT CONSTRAINT_NAME AS constraintName FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'StockMovements' AND COLUMN_NAME = 'recordedById' AND LOWER(REFERENCED_TABLE_NAME) = 'users' ORDER BY CONSTRAINT_NAME"
  );
  if (!recordedByForeignKeys.length) {
    await queryInterface.addConstraint("StockMovements", {
      fields: ["recordedById"],
      type: "foreign key",
      name: "fk_stock_movements_recorded_by",
      references: { table: "Users", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT"
    });
  } else {
    for (const constraint of recordedByForeignKeys.slice(1)) {
      await queryInterface.removeConstraint("StockMovements", constraint.constraintName);
    }
  }
};

// Changes to the existing `Users` table for HR sync and ESS sign-in. These strings are
// exactly what runs; docs/sql/2026-11-16-hr-sync-ess-login.sql lists the same SQL for review.
// Every statement runs only when the column is missing (or, for `password`, still NOT NULL).
export const ESS_LOGIN_USER_COLUMNS = [
  ["position", "ALTER TABLE `Users` ADD COLUMN `position` VARCHAR(160) NULL"],
  ["hrStatus", "ALTER TABLE `Users` ADD COLUMN `hrStatus` VARCHAR(30) NULL"],
  ["roleOverridden", "ALTER TABLE `Users` ADD COLUMN `roleOverridden` TINYINT(1) NOT NULL DEFAULT 0"],
  ["activatedAt", "ALTER TABLE `Users` ADD COLUMN `activatedAt` DATETIME NULL"],
  ["hrSyncedAt", "ALTER TABLE `Users` ADD COLUMN `hrSyncedAt` DATETIME NULL"]
];
export const ESS_LOGIN_PASSWORD_NULLABLE_SQL = "ALTER TABLE `Users` MODIFY `password` VARCHAR(255) NULL";
// Accounts that existed before this change count as already activated, so a manager's
// earlier deactivation is not reversed by an ESS sign-in.
export const ESS_LOGIN_ACTIVATED_BACKFILL_SQL = "UPDATE `Users` SET `activatedAt` = `createdAt` WHERE `activatedAt` IS NULL";

export const ensureEssLoginSchema = async () => {
  const queryInterface = sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  const usersTableExists = tables.some(table =>
    String(typeof table === "string" ? table : table.tableName).toLowerCase() === "users"
  );
  if (!usersTableExists) return [];

  const executed = [];
  const run = async sql => {
    await sequelize.query(sql);
    executed.push(sql);
  };
  const columns = await queryInterface.describeTable("Users");
  if (columns.password && columns.password.allowNull === false) await run(ESS_LOGIN_PASSWORD_NULLABLE_SQL);
  for (const [column, sql] of ESS_LOGIN_USER_COLUMNS) {
    if (!columns[column]) await run(sql);
  }
  if (!columns.activatedAt) await run(ESS_LOGIN_ACTIVATED_BACKFILL_SQL);
  return executed;
};

export const ensureHrIntegrationSchema = async () => {
  const queryInterface = sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  const usersTableExists = tables.some(table =>
    String(typeof table === "string" ? table : table.tableName).toLowerCase() === "users"
  );
  if (!usersTableExists) return;

  const userColumns = await queryInterface.describeTable("Users");
  if (!userColumns.hrEmployeeId) {
    await queryInterface.addColumn("Users", "hrEmployeeId", {
      type: DataTypes.STRING(120),
      allowNull: true
    });
  }
  const indexes = await queryInterface.showIndex("Users");
  if (!indexes.some(index => index.name === "idx_users_hr_employee_id")) {
    await queryInterface.addIndex("Users", ["hrEmployeeId"], {
      name: "idx_users_hr_employee_id",
      unique: true
    });
  }
};
