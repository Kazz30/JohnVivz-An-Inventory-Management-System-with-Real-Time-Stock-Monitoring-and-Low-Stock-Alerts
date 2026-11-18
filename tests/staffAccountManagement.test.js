import test from "node:test";
import assert from "node:assert/strict";
import router from "../routes/index.js";
import { User } from "../models/index.js";
import { sequelize } from "../models/db.js";
import { ensureHrIntegrationSchema } from "../models/legacyMigration.js";

test("user management keeps account listing and editing but has no account creation route", () => {
  const userRoutes = router.stack
    .filter(layer => layer.route?.path === "/users")
    .map(layer => layer.route.methods);

  assert.deepEqual(userRoutes, [{ get: true }]);
  assert.ok(router.stack.some(layer => layer.route?.path === "/users/:id/edit" && layer.route.methods.get));
  assert.ok(router.stack.some(layer => layer.route?.path === "/users/:id/update" && layer.route.methods.post));
});

test("HR employee identifiers are optional and uniquely indexed", () => {
  assert.equal(User.rawAttributes.hrEmployeeId.allowNull, true);
  assert.ok(User.options.indexes.some(index =>
    index.name === "idx_users_hr_employee_id" &&
    index.unique &&
    index.fields.includes("hrEmployeeId")
  ));
});

test("HR schema setup adds the employee ID column before its unique index", async () => {
  const originalGetQueryInterface = sequelize.getQueryInterface;
  const calls = [];
  const queryInterface = {
    showAllTables: async () => ["Users"],
    describeTable: async () => ({ email: {} }),
    addColumn: async (table, column) => calls.push(["addColumn", table, column]),
    showIndex: async () => [],
    addIndex: async (table, fields, options) => calls.push(["addIndex", table, fields, options])
  };
  sequelize.getQueryInterface = () => queryInterface;

  try {
    await ensureHrIntegrationSchema();
  } finally {
    sequelize.getQueryInterface = originalGetQueryInterface;
  }

  assert.deepEqual(calls.map(call => call[0]), ["addColumn", "addIndex"]);
  assert.equal(calls[0][2], "hrEmployeeId");
  assert.deepEqual(calls[1][2], ["hrEmployeeId"]);
});
