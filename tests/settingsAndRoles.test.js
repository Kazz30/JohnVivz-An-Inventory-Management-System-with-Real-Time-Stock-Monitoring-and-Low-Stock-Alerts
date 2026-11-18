import test from "node:test";
import assert from "node:assert/strict";
import { getSettings, hrSyncConfigured } from "../config/settings.js";
import { parsePositionRoleMap, roleForPosition } from "../services/roleMapping.js";

test("ESS login mode defaults to local and falls back to local on bad values", () => {
  assert.equal(getSettings({}).essLoginMode, "local");
  assert.equal(getSettings({ ESS_LOGIN_MODE: "LIVE" }).essLoginMode, "live");
  const bad = getSettings({ ESS_LOGIN_MODE: "yes" });
  assert.equal(bad.essLoginMode, "local");
  assert.equal(bad.essLoginModeInvalid, true);
});

test("settings read the agreed .env names and trim URLs", () => {
  const settings = getSettings({
    HR_API_URL: "http://localhost:3001/", HR_API_TOKEN: "hr", JVZPAY_API_URL: "http://localhost:3002//",
    JVZPAY_API_TOKEN: "pay", INVENTORY_DEPARTMENT_CODE: "INV"
  });
  assert.equal(settings.hrApiUrl, "http://localhost:3001");
  assert.equal(settings.jvzpayApiUrl, "http://localhost:3002");
  assert.equal(settings.hrSyncIntervalMs, 5 * 60 * 1000);
  assert.deepEqual(settings.essAllowedStatuses, ["Active", "On Leave"]);
  assert.deepEqual(getSettings({ ESS_ALLOWED_STATUSES: "Active" }).essAllowedStatuses, ["Active"]);
  assert.equal(hrSyncConfigured(settings), true);
  assert.equal(hrSyncConfigured(getSettings({ HR_API_URL: "x", HR_API_TOKEN: "y" })), false);
});

test("default position mapping uses HR's Inventory titles", () => {
  const { rules, errors } = parsePositionRoleMap();
  assert.deepEqual(errors, []);
  assert.equal(roleForPosition("Inventory Manager", rules), "manager");
  assert.equal(roleForPosition("inventory supervisor", rules), "supervisor");
  assert.equal(roleForPosition("Inventory Staff", rules), "staff");
  assert.equal(roleForPosition("Store Manager", rules), "staff", "other titles get the least privilege");
  assert.equal(roleForPosition("Warehouse Clerk", rules), "staff");
  assert.equal(roleForPosition("", rules), "staff");
  assert.equal(roleForPosition(null, rules), "staff");
});

test("custom position mapping is ordered and rejects unknown roles", () => {
  const { rules, errors } = parsePositionRoleMap("Supervisor=supervisor; Manager=manager, Boss=owner, =staff");
  assert.deepEqual(errors, ["Boss=owner", "=staff"]);
  assert.equal(roleForPosition("Stock Supervisor", rules), "supervisor");
  assert.equal(roleForPosition("Supervisor and Manager", rules), "supervisor");
  assert.equal(roleForPosition("Manager", rules), "manager");
});
