// Database-backed tests. They run only when TEST_DB_NAME names a throwaway MySQL database
// whose name ends in "_test"; the database is dropped and recreated at the start and
// dropped at the end. Example (PowerShell):
//   $env:TEST_DB_NAME = "johnvivz_inventory_test"; npm test
import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";

const TEST_DB = process.env.TEST_DB_NAME || "";

if (!TEST_DB) {
  test("database-backed tests", { skip: "set TEST_DB_NAME=<name>_test to run them" }, () => {});
} else {
  if (!/^[A-Za-z0-9_]+_test$/.test(TEST_DB)) throw new Error("TEST_DB_NAME must contain only letters, digits, _ and end in _test.");
  const connection = {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || ""
  };
  const admin = await mysql.createConnection(connection);
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
  await admin.query(`USE \`${TEST_DB}\``);
  // A Users table as it exists in today's deployments, before this change.
  await admin.query("CREATE TABLE `Roles` (`id` INT AUTO_INCREMENT PRIMARY KEY, `name` VARCHAR(30) NOT NULL UNIQUE, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)");
  await admin.query("INSERT INTO `Roles` (`name`, `createdAt`, `updatedAt`) VALUES ('manager', NOW(), NOW()), ('supervisor', NOW(), NOW()), ('staff', NOW(), NOW())");
  await admin.query("CREATE TABLE `Users` (`id` INT AUTO_INCREMENT PRIMARY KEY, `name` VARCHAR(120) NOT NULL, `email` VARCHAR(190) NOT NULL UNIQUE, `password` VARCHAR(255) NOT NULL, `role` VARCHAR(30) NOT NULL DEFAULT 'staff', `isActive` TINYINT(1) NOT NULL DEFAULT 1, `RoleId` INT NULL, `hrEmployeeId` VARCHAR(120) NULL, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)");

  process.env.DB_NAME = TEST_DB;
  delete process.env.INVENTORY_INTEGRATION_TOKEN;
  delete process.env.ESS_LOGIN_MODE;

  const bcrypt = (await import("bcrypt")).default;
  const passwordHash = await bcrypt.hash("manager-password-1", 4);
  await admin.query(
    "INSERT INTO `Users` (`name`, `email`, `password`, `role`, `isActive`, `RoleId`, `createdAt`, `updatedAt`) VALUES " +
    "('Local Manager', 'admin@johnvivz.test', ?, 'manager', 1, 1, NOW(), NOW()), " +
    "('Old Staff', 'old.staff@johnvivz.test', ?, 'staff', 1, 3, NOW(), NOW()), " +
    "('Disabled Staff', 'disabled@johnvivz.test', ?, 'staff', 0, 3, NOW(), NOW())",
    [passwordHash, passwordHash, passwordHash]
  );

  const { default: app } = await import("../index.js");
  const models = await import("../models/index.js");
  const { sequelize, User, Role, LoginAttempt, Product, Inventory, StockReservation, IntegrationOutbox, IntegrationInbox, StockMovement } = models;
  const migration = await import("../models/legacyMigration.js");
  const { getSettings } = await import("../config/settings.js");
  const { syncHrEmployees, NOT_IN_HR_STATUS, LEFT_DEPARTMENT_STATUS } = await import("../services/hrSyncService.js");
  const login = await import("../services/loginService.js");

  test.after(async () => {
    await sequelize.close();
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  test("Users migration runs exactly the reviewed SQL once and backfills activatedAt", async () => {
    await migration.ensureHrIntegrationSchema();
    const executed = await migration.ensureEssLoginSchema();
    assert.deepEqual(executed, [
      migration.ESS_LOGIN_PASSWORD_NULLABLE_SQL,
      ...migration.ESS_LOGIN_USER_COLUMNS.map(([, sql]) => sql),
      migration.ESS_LOGIN_ACTIVATED_BACKFILL_SQL
    ]);
    assert.deepEqual(await migration.ensureEssLoginSchema(), [], "second run changes nothing");

    await sequelize.sync();
    await migration.migrateLegacyUsers();
    await migration.ensureIntegrationSchema();
    await migration.ensureApplicationIndexes();

    const columns = await sequelize.getQueryInterface().describeTable("Users");
    assert.equal(columns.password.allowNull, true);
    for (const column of ["position", "hrStatus", "roleOverridden", "activatedAt", "hrSyncedAt"]) assert.ok(columns[column], column);
    for (const forbidden of ["salary", "birthDate", "address", "employeeCode"]) assert.equal(columns[forbidden], undefined);
    const legacy = await User.findAll();
    assert.equal(legacy.length, 3);
    assert.ok(legacy.every(user => user.activatedAt), "existing accounts count as already activated");
  });

  // ---------- HR sync ----------
  const hrSettings = (extra = {}) => getSettings({
    HR_API_URL: "http://hr.test", HR_API_TOKEN: "hr-key", INVENTORY_DEPARTMENT_CODE: "INV", ...extra
  });
  const hrEmployee = (id, fields = {}) => ({
    permanent_employee_id: id, employee_code: `UNIQUE-${id}`, full_name: `Employee ${id}`,
    email: `${id.toLowerCase()}@johnvivz.test`, position: "Stock Clerk", status: "Active",
    department: { department_id: 4, department_name: "Inventory", department_code: "INV" },
    salary: 50000, ...fields
  });
  const fakeHr = ({ employees, lookup = {}, failList = false }) => ({
    listDepartments: async () => [{ department_id: 4, department_code: "INV" }, { department_id: 5, department_code: "SALES" }],
    listEmployees: async ({ departmentId }) => {
      assert.equal(departmentId, 4);
      if (failList) throw new Error("HR timeout on page 3");
      return employees;
    },
    getEmployee: async id => (id in lookup ? lookup[id] : null)
  });

  test("HR sync creates deactivated accounts with no password, maps roles and links old accounts", async () => {
    const summary = await syncHrEmployees({
      settings: hrSettings(),
      client: fakeHr({ employees: [
        hrEmployee("JV-2026-00001", { position: "Inventory Manager" }),
        hrEmployee("JV-2026-00002", { status: "Onboarding" }),
        hrEmployee("JV-2026-00003", { status: "Resigned" }),
        hrEmployee("JV-2026-00009", { department: { department_id: 5, department_code: "SALES" } }),
        hrEmployee("JV-2026-00010", { email: "old.staff@johnvivz.test" }),
        hrEmployee("JV-2026-00011", { email: "admin@johnvivz.test", position: "Manager" })
      ] })
    });
    assert.deepEqual(summary.created.sort(), ["JV-2026-00001", "JV-2026-00002"]);
    assert.deepEqual(summary.linked, ["JV-2026-00010"]);
    assert.equal(summary.skipped.length, 1, "resigned employee without an account is not created");
    assert.ok(summary.conflicts.some(conflict => conflict.employeeId === "JV-2026-00011"), "emergency admin is never adopted");

    const manager = await User.findOne({ where: { hrEmployeeId: "JV-2026-00001" }, include: Role });
    assert.equal(manager.isActive, false);
    assert.equal(manager.password, null);
    assert.equal(manager.activatedAt, null);
    assert.equal(manager.Role.name, "manager");
    const clerk = await User.findOne({ where: { hrEmployeeId: "JV-2026-00002" }, include: Role });
    assert.equal(clerk.Role.name, "staff");
    assert.equal(clerk.hrStatus, "Onboarding");
    assert.equal(await User.count({ where: { hrEmployeeId: "JV-2026-00009" } }), 0, "other departments are ignored");
    const admin = await User.findOne({ where: { email: "admin@johnvivz.test" } });
    assert.equal(admin.hrEmployeeId, null);
  });

  test("a manager role override survives later syncs; position changes remap other roles", async () => {
    const supervisor = await Role.findOne({ where: { name: "supervisor" } });
    await User.update({ RoleId: supervisor.id, role: "supervisor", roleOverridden: true }, { where: { hrEmployeeId: "JV-2026-00002" } });
    await syncHrEmployees({
      settings: hrSettings(),
      client: fakeHr({ employees: [
        hrEmployee("JV-2026-00001", { position: "Warehouse Clerk" }),
        hrEmployee("JV-2026-00002", { position: "Assistant Manager" }),
        hrEmployee("JV-2026-00010", { email: "old.staff@johnvivz.test" })
      ] })
    });
    const one = await User.findOne({ where: { hrEmployeeId: "JV-2026-00001" }, include: Role });
    const two = await User.findOne({ where: { hrEmployeeId: "JV-2026-00002" }, include: Role });
    assert.equal(one.Role.name, "staff");
    assert.equal(two.Role.name, "supervisor");
    assert.equal(two.position, "Assistant Manager");
  });

  test("a failed HR read changes nothing", async () => {
    const before = JSON.stringify(await User.findAll({ order: [["id", "ASC"]], raw: true }));
    await assert.rejects(syncHrEmployees({ settings: hrSettings(), client: fakeHr({ employees: [], failList: true }) }), /HR timeout/);
    await assert.rejects(syncHrEmployees({ settings: hrSettings({ INVENTORY_DEPARTMENT_CODE: "NOPE" }), client: fakeHr({ employees: [] }) }), /no department/);
    assert.equal(JSON.stringify(await User.findAll({ order: [["id", "ASC"]], raw: true })), before);
  });

  // ---------- Sign-in ----------
  const liveSettings = (extra = {}) => getSettings({
    ESS_LOGIN_MODE: "live", JVZPAY_API_URL: "http://pay.test", JVZPAY_API_TOKEN: "pay-token",
    INVENTORY_DEPARTMENT_CODE: "INV", EXTERNAL_REQUEST_TIMEOUT_MS: "500", ...extra
  });
  const essOk = (id, fields = {}) => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        employee_id: id, employee_code: "UNIQUE", full_name: "x", email: `${id.toLowerCase()}@johnvivz.test`,
        department_code: "INV", department_name: "Inventory", position: "Clerk", employment_status: "Active",
        ess_registered_at: "2026-11-10T00:00:00Z", ...fields
      }), { status: 200 });
    };
    fetchImpl.calls = calls;
    return fetchImpl;
  };
  let ipCounter = 0;
  const ip = () => `10.0.0.${++ipCounter}`;

  test("local mode keeps today's password sign-in and audits it", async () => {
    const settings = getSettings({});
    const ok = await login.authenticate({ email: "ADMIN@johnvivz.test", password: "manager-password-1", ipAddress: ip(), settings });
    assert.equal(ok.ok, true);
    const bad = await login.authenticate({ email: "admin@johnvivz.test", password: "wrong-password", ipAddress: ip(), settings });
    assert.deepEqual(bad, { ok: false, message: login.GENERIC_LOGIN_ERROR });
    const pending = await login.authenticate({ email: "jv-2026-00002@johnvivz.test", password: "anything-123", ipAddress: ip(), settings });
    assert.equal(pending.message, login.GENERIC_LOGIN_ERROR, "HR accounts have no local password");
    const rows = await LoginAttempt.findAll({ where: { email: "admin@johnvivz.test" }, order: [["id", "ASC"]] });
    assert.deepEqual(rows.map(row => [row.mode, row.outcome, row.reason]), [
      ["local", "success", "local_password"], ["local", "failure", "wrong_password"]
    ]);
  });

  test("live mode: first ESS success activates the synced account; the password is never stored", async () => {
    await User.update({ hrStatus: "Active" }, { where: { hrEmployeeId: "JV-2026-00001" } });
    const fetchImpl = essOk("JV-2026-00001");
    const result = await login.authenticate({
      email: "jv-2026-00001@johnvivz.test", password: "Ess-Password-77", ipAddress: ip(), settings: liveSettings(), fetchImpl
    });
    assert.equal(result.ok, true);
    assert.deepEqual(fetchImpl.calls, [{ email: "jv-2026-00001@johnvivz.test", password: "Ess-Password-77" }]);
    const user = await User.findOne({ where: { hrEmployeeId: "JV-2026-00001" } });
    assert.equal(user.isActive, true);
    assert.ok(user.activatedAt);
    assert.equal(user.password, null);
    const [allUsers, allAttempts] = await Promise.all([User.findAll({ raw: true }), LoginAttempt.findAll({ raw: true })]);
    assert.ok(!JSON.stringify([allUsers, allAttempts]).includes("Ess-Password-77"));
    const audit = await LoginAttempt.findOne({ where: { userId: user.id }, order: [["id", "DESC"]] });
    assert.deepEqual([audit.mode, audit.outcome, audit.reason], ["live", "success", "ess_first_activation"]);
  });

  test("live mode refuses everything else with one generic error, or ESS unavailable", async () => {
    const attempt = (email, fetchImpl, settings = liveSettings()) =>
      login.authenticate({ email, password: "Some-Password-1", ipAddress: ip(), settings, fetchImpl });
    const generic = { ok: false, message: login.GENERIC_LOGIN_ERROR };
    const reject401 = async () => new Response(JSON.stringify({ error: "invalid_credentials" }), { status: 401 });
    const reject403 = async () => new Response(JSON.stringify({ error: "not_allowed" }), { status: 403 });

    assert.deepEqual(await attempt("jv-2026-00001@johnvivz.test", reject401), generic);
    assert.deepEqual(await attempt("jv-2026-00001@johnvivz.test", reject403), generic);
    assert.deepEqual(await attempt("jv-2026-00001@johnvivz.test", essOk("JV-2026-00001", { department_code: "SALES" })), generic);
    assert.deepEqual(await attempt("jv-2026-00001@johnvivz.test", essOk("JV-2026-00001", { employment_status: "Onboarding" })), generic);
    assert.deepEqual(await attempt("jv-2026-00001@johnvivz.test", essOk("JV-2026-00001", { employment_status: "Resigned" })), generic);
    await LoginAttempt.destroy({ where: { email: "jv-2026-00001@johnvivz.test" } }); // stay under the rate limit
    assert.equal((await attempt("jv-2026-00001@johnvivz.test", essOk("JV-2026-00001", { employment_status: "On Leave" }))).ok, true,
      "On Leave may sign in by default");
    assert.deepEqual(await attempt("jv-2026-00077@johnvivz.test", essOk("JV-2026-00077")), generic, "not in the synced list");
    assert.deepEqual(await attempt("jv-2026-00001@johnvivz.test", essOk("JV-2026-00002", { email: "jv-2026-00001@johnvivz.test" })), generic);
    const linked = await attempt("old.staff@johnvivz.test", essOk("JV-2026-00010", { email: "old.staff@johnvivz.test" }));
    assert.equal(linked.ok, true, "a linked pre-existing account signs in through ESS");

    // A manager-blocked pending account is not activated by ESS.
    await User.update({ activatedAt: new Date(), hrStatus: "Active" }, { where: { hrEmployeeId: "JV-2026-00002" } });
    assert.deepEqual(await attempt("jv-2026-00002@johnvivz.test", essOk("JV-2026-00002")), generic);

    await LoginAttempt.destroy({ where: { email: "jv-2026-00001@johnvivz.test" } }); // stay under the rate limit
    const down = async () => { throw new TypeError("fetch failed"); };
    assert.deepEqual(await attempt("jv-2026-00001@johnvivz.test", down), { ok: false, message: login.ESS_UNAVAILABLE_ERROR });
    assert.deepEqual(await attempt("jv-2026-00001@johnvivz.test", async () => new Response("", { status: 502 })),
      { ok: false, message: login.ESS_UNAVAILABLE_ERROR });
    assert.equal(login.ESS_UNAVAILABLE_ERROR, "ESS is unavailable, try again later.");
  });

  test("live mode keeps exactly one local emergency admin", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return new Response("{}", { status: 401 }); };
    const ok = await login.authenticate({
      email: "admin@johnvivz.test", password: "manager-password-1", ipAddress: ip(), settings: liveSettings(), fetchImpl
    });
    assert.equal(ok.ok, true);
    assert.equal(called, false, "emergency admin never goes to JVzPay");
    const audit = await LoginAttempt.findOne({ where: { email: "admin@johnvivz.test" }, order: [["id", "DESC"]] });
    assert.equal(audit.mode, "emergency");

    // Another local account (old staff, now HR-linked) cannot use its old local password in live mode.
    const legacy = await login.authenticate({
      email: "old.staff@johnvivz.test", password: "manager-password-1", ipAddress: ip(), settings: liveSettings(), fetchImpl
    });
    assert.equal(legacy.message, login.GENERIC_LOGIN_ERROR);
    assert.equal(called, true);

    // EMERGENCY_ADMIN_EMAIL pointing elsewhere removes the default.
    const elsewhere = await login.authenticate({
      email: "admin@johnvivz.test", password: "manager-password-1", ipAddress: ip(),
      settings: liveSettings({ EMERGENCY_ADMIN_EMAIL: "someone@johnvivz.test" }), fetchImpl
    });
    assert.equal(elsewhere.ok, false);
  });

  test("sign-in is rate limited per email and audited", async () => {
    const email = "jv-2026-00001@johnvivz.test";
    const reject = async () => new Response(JSON.stringify({ error: "invalid_credentials" }), { status: 401 });
    await LoginAttempt.destroy({ where: { email } });
    for (let i = 0; i < login.MAX_FAILURES_PER_EMAIL; i += 1) {
      await login.authenticate({ email, password: "bad-password", ipAddress: ip(), settings: liveSettings(), fetchImpl: reject });
    }
    const fetchImpl = essOk("JV-2026-00001");
    const blocked = await login.authenticate({ email, password: "right-password", ipAddress: ip(), settings: liveSettings(), fetchImpl });
    assert.deepEqual(blocked, { ok: false, message: login.RATE_LIMITED_ERROR });
    assert.equal(fetchImpl.calls.length, 0, "rate-limited attempts never reach JVzPay");
    assert.equal(await LoginAttempt.count({ where: { email, outcome: "rate_limited" } }), 1);
  });

  test("Resigned/Terminated in HR deactivates at once and ends sessions; leaving the department too", async () => {
    const one = await User.findOne({ where: { hrEmployeeId: "JV-2026-00001" } });
    const old = await User.findOne({ where: { hrEmployeeId: "JV-2026-00010" } });
    assert.equal(one.isActive, true);
    await sequelize.query("INSERT INTO `Sessions` (`sid`, `expiresAt`, `data`, `createdAt`) VALUES (?, DATE_ADD(NOW(), INTERVAL 1 HOUR), ?, NOW()), (?, DATE_ADD(NOW(), INTERVAL 1 HOUR), ?, NOW())",
      { replacements: ["sid-one", JSON.stringify({ cookie: {}, userId: one.id }), "sid-other", JSON.stringify({ cookie: {}, userId: old.id })] });

    const summary = await syncHrEmployees({
      settings: hrSettings(),
      client: fakeHr({
        employees: [hrEmployee("JV-2026-00001", { status: "Terminated" }), hrEmployee("JV-2026-00010", { email: "old.staff@johnvivz.test" })],
        lookup: { "JV-2026-00002": hrEmployee("JV-2026-00002", { department: { department_id: 5, department_code: "SALES" } }) }
      }),
      sessionEnder: (await import("../services/sessionService.js")).endUserSessions
    });
    await one.reload();
    assert.equal(one.isActive, false);
    assert.equal(one.hrStatus, "Terminated");
    const [sessions] = await sequelize.query("SELECT `sid` FROM `Sessions` ORDER BY `sid`");
    assert.deepEqual(sessions.map(row => row.sid), ["sid-other"]);
    const two = await User.findOne({ where: { hrEmployeeId: "JV-2026-00002" } });
    assert.equal(two.hrStatus, LEFT_DEPARTMENT_STATUS);
    assert.equal(two.isActive, false);
    assert.ok(summary.deactivated.some(item => item.employeeId === "JV-2026-00001"));

    await LoginAttempt.destroy({ where: { email: "jv-2026-00001@johnvivz.test" } });
    const terminatedLogin = await login.authenticate({
      email: "jv-2026-00001@johnvivz.test", password: "x-password", ipAddress: ip(), settings: liveSettings(), fetchImpl: essOk("JV-2026-00001")
    });
    assert.equal(terminatedLogin.message, login.GENERIC_LOGIN_ERROR);

    // Removed from HR entirely.
    await syncHrEmployees({ settings: hrSettings(), client: fakeHr({ employees: [] }) });
    await old.reload();
    assert.equal(old.isActive, false);
    assert.equal(old.hrStatus, NOT_IN_HR_STATUS);
    assert.equal(NOT_IN_HR_STATUS, "Not found in HR");
  });

  // ---------- HTTP: CRM events and stock permissions ----------
  let server;
  let baseUrl;
  let crmToken;
  let accountingToken;
  const startServer = async () => {
    if (server) return;
    server = await new Promise(resolve => { const listener = app.listen(0, () => resolve(listener)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const { createIntegrationToken } = await import("../services/integrationTokens.js");
    crmToken = (await createIntegrationToken({ system: "crm", name: "CRM test" })).token;
    accountingToken = (await createIntegrationToken({ system: "accounting", name: "JVzPay test" })).token;
  };
  const api = (path, token, options = {}) => fetch(`${baseUrl}/api/integration/v1${path}`, {
    ...options,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(options.headers || {}) }
  });
  test.after(() => server && new Promise(resolve => server.close(resolve)));

  const makeProduct = async (sku, quantity) => {
    const product = await Product.create({ name: `Product ${sku}`, sku, unitPrice: "10.00", currentStock: quantity, minimumStock: 0 });
    await Inventory.create({ ProductId: product.id, quantity });
    return product;
  };
  const postEvent = body => fetch(`${baseUrl}/api/integration/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${crmToken}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  test("order.confirmed with not enough stock: 409 insufficient_stock and no partial reservation", async () => {
    await startServer();
    const plenty = await makeProduct("SKU-PLENTY", 5);
    const scarce = await makeProduct("SKU-SCARCE", 1);
    const outboxBefore = await IntegrationOutbox.count();
    const event = {
      eventId: "crm-evt-short-1", eventType: "order.confirmed", orderReference: "CRM-ORDER-1",
      items: [{ productId: plenty.id, quantity: 2 }, { productId: scarce.id, quantity: 3 }]
    };
    const response = await postEvent(event);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: `Insufficient available stock for Product SKU-SCARCE.`,
      code: "insufficient_stock",
      details: {
        orderReference: "CRM-ORDER-1",
        reserved: false,
        shortages: [{ productId: scarce.id, sku: "SKU-SCARCE", requestedQuantity: 3, availableStock: 1 }]
      }
    });
    assert.equal(await StockReservation.count({ where: { orderReference: "CRM-ORDER-1" } }), 0, "nothing reserved, not even the line that fit");
    assert.equal(await IntegrationOutbox.count(), outboxBefore, "no StockReserved events leaked");
    assert.equal(await IntegrationInbox.count({ where: { eventId: "crm-evt-short-1" } }), 0, "a rejected event can be retried");

    // After restocking, the same event (same eventId) succeeds.
    const { recordMovement } = await import("../services/inventoryService.js");
    await sequelize.transaction(transaction => recordMovement({ productId: scarce.id, movementType: "stock_in", quantity: 5, transaction }));
    const retry = await postEvent(event);
    assert.equal(retry.status, 202);
    assert.deepEqual((await retry.json()).result.reservations.map(item => item.status), ["reserved", "reserved"]);
  });

  test("repeating an orderReference never reserves twice", async () => {
    const product = await Product.findOne({ where: { sku: "SKU-PLENTY" } });
    const scarce = await Product.findOne({ where: { sku: "SKU-SCARCE" } });
    const items = [{ productId: product.id, quantity: 2 }, { productId: scarce.id, quantity: 3 }];
    const sum = async reference => Number(await StockReservation.sum("quantity", { where: { orderReference: reference } }) || 0);

    const sameId = await postEvent({ eventId: "crm-evt-short-1", eventType: "order.confirmed", orderReference: "CRM-ORDER-1", items });
    assert.equal(sameId.status, 200);
    assert.equal((await sameId.json()).duplicate, true);

    const newId = await postEvent({ eventId: "crm-evt-other-2", eventType: "order.confirmed", orderReference: "CRM-ORDER-1", items });
    assert.equal(newId.status, 200);
    const newIdBody = await newId.json();
    assert.equal(newIdBody.duplicate, true);
    assert.equal(newIdBody.eventId, "crm-evt-other-2");
    assert.equal(await sum("CRM-ORDER-1"), 5);

    const changed = await postEvent({ eventId: "crm-evt-other-3", eventType: "order.confirmed", orderReference: "CRM-ORDER-1",
      items: [{ productId: product.id, quantity: 1 }] });
    assert.equal(changed.status, 409);
    assert.equal(await sum("CRM-ORDER-1"), 5);

    // Two different eventIds for one new order racing each other.
    const race = await Promise.all([1, 2, 3].map(n => postEvent({
      eventId: `crm-evt-race-${n}`, eventType: "order.confirmed", orderReference: "CRM-ORDER-RACE",
      items: [{ productId: product.id, quantity: 1 }]
    })));
    assert.deepEqual(race.map(r => r.status).sort(), [200, 200, 202]);
    assert.equal(await sum("CRM-ORDER-RACE"), 1);
    assert.equal(await StockReservation.count({ where: { orderReference: "CRM-ORDER-RACE" } }), 1);
  });

  // Minimal cookie-aware browser for the HTML app.
  const browser = async (email, password) => {
    let cookie = "";
    const keep = response => {
      const set = response.headers.getSetCookie().find(value => value.startsWith("johnvivz.sid="));
      if (set) cookie = set.split(";")[0];
      return response;
    };
    const request = (path, options = {}) => fetch(`${baseUrl}${path}`, {
      redirect: "manual", ...options, headers: { ...(options.headers || {}), cookie }
    }).then(keep);
    const signIn = await request("/login", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password })
    });
    assert.equal(signIn.headers.get("location"), "/dashboard", `sign-in for ${email}`);
    const html = await (await request("/inventory")).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)[1];
    return {
      html,
      get: path => request(path),
      post: (path, fields) => request(path, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: csrf, ...fields })
      })
    };
  };

  test("user management shows HR accounts and lets a manager override or reset the role", async () => {
    await startServer();
    const manager = await browser("admin@johnvivz.test", "manager-password-1");
    const list = await (await manager.get("/users")).text();
    assert.match(list, /Inactive|Pending first ESS sign-in/);
    assert.match(list, /HR sync is off/);
    assert.ok(!list.includes("/users/hr-sync"), "no Sync now button without HR settings");
    const hrUser = await User.findOne({ where: { hrEmployeeId: "JV-2026-00001" } });
    const edit = await (await manager.get(`/users/${hrUser.id}/edit`)).text();
    assert.match(edit, /Role source/);
    assert.ok(!edit.includes("name=\"password\""), "no local password field for HR accounts");

    const supervisor = await Role.findOne({ where: { name: "supervisor" } });
    await manager.post(`/users/${hrUser.id}/update`, { roleSource: "manual", roleId: supervisor.id, password: "ignored-password-1" });
    await hrUser.reload();
    assert.equal(hrUser.role, "supervisor");
    assert.equal(hrUser.roleOverridden, true);
    assert.equal(hrUser.password, null);
    await manager.post(`/users/${hrUser.id}/update`, { roleSource: "hr", roleId: supervisor.id });
    await hrUser.reload();
    assert.equal(hrUser.roleOverridden, false);
    assert.equal(hrUser.role, "staff", "position Stock Clerk maps back to staff");

    const sync = await manager.post("/users/hr-sync", {});
    assert.equal(sync.status, 302, "Sync now without HR settings is refused, not a crash");

    // HR-linked employees see a read-only profile and cannot set a local password.
    await User.update({ isActive: true, hrStatus: "Active" }, { where: { hrEmployeeId: "JV-2026-00010" } });
    await LoginAttempt.destroy({ where: { email: "old.staff@johnvivz.test" } });
    const employee = await browser("old.staff@johnvivz.test", "manager-password-1");
    const profile = await (await employee.get("/profile")).text();
    assert.match(profile, /managed|ESS/);
    await employee.post("/profile", { name: "x", email: "x@johnvivz.test", password: "new-local-pass-1" });
    const after = await User.findOne({ where: { hrEmployeeId: "JV-2026-00010" } });
    assert.equal(after.email, "old.staff@johnvivz.test");
  });

  test("per-system tokens over HTTP: each token only reaches its own routes; only hashes are stored", async () => {
    await startServer();
    const { IntegrationToken } = models;
    assert.equal((await api("/products")).status, 401, "no token");
    assert.equal((await api("/products", "jvi_crm_not-a-real-token")).status, 401, "unknown token");

    // CRM token
    assert.equal((await api("/products", crmToken)).status, 200);
    assert.equal((await api("/crm/outbox", crmToken)).status, 200);
    const crmOnAccounting = await api("/accounting/outbox", crmToken);
    assert.equal(crmOnAccounting.status, 403);
    assert.deepEqual(await crmOnAccounting.json(), { error: "This integration token is not allowed to use this route." });
    assert.equal((await api("/accounting/outbox/00000000-0000-4000-8000-000000000000/ack", crmToken, { method: "POST" })).status, 403);

    // Accounting token
    assert.equal((await api("/accounting/outbox", accountingToken)).status, 200);
    assert.equal((await api("/crm/outbox", accountingToken)).status, 403);
    assert.equal((await api("/crm/outbox/00000000-0000-4000-8000-000000000000/ack", accountingToken, { method: "POST" })).status, 403);
    assert.equal((await api("/products", accountingToken)).status, 403);
    assert.equal((await api("/products/1/price", accountingToken)).status, 403);
    assert.equal((await api("/events", accountingToken, { method: "POST", body: "{}" })).status, 403);

    // Only hashes in the database.
    const rows = await IntegrationToken.findAll({ raw: true });
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(crmToken) && !dump.includes(accountingToken), "plaintext tokens are never stored");
    assert.ok(rows.every(row => /^[0-9a-f]{64}$/.test(row.tokenHash)));
  });

  test("token CLI creates, lists and revokes; a revoked token gets 401 at once", async () => {
    await startServer();
    const { execFile } = await import("node:child_process");
    // Async on purpose: a blocking exec would stall the test server's event loop.
    const cli = (...args) => new Promise((resolve, reject) => execFile(process.execPath, ["scripts/integration-tokens.js", ...args], {
      env: { ...process.env, DB_NAME: TEST_DB, INVENTORY_SKIP_DOTENV: "1" }, encoding: "utf8"
    }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
    const created = (await cli("create", "accounting", "CLI", "test")).trim().split(/\r?\n/);
    const token = created.at(-1);
    const id = /#(\d+)/.exec(created[0])[1];
    assert.match(token, /^jvi_accounting_[A-Za-z0-9_-]{43}$/);
    assert.equal((await api("/accounting/outbox", token)).status, 200);
    assert.match(await cli("list"), new RegExp(`#${id}\\s+accounting\\s+"CLI test"\\s+jvi_accounting_\\S+\\s+active`));
    assert.match(await cli("revoke", id), /revoked/);
    assert.equal((await api("/accounting/outbox", token)).status, 401);
    assert.match(await cli("list"), new RegExp(`#${id}.*REVOKED`));
    assert.match(await cli("revoke", id), /No active token/);
    await assert.rejects(cli("create", "hr", "nope"), /System must be one of/);
  });

  test("money in every event is a two-decimal string (product and purchase-order events)", async () => {
    await startServer();
    const { Supplier, PurchaseOrder, PurchaseOrderItem } = models;
    const manager = await browser("admin@johnvivz.test", "manager-password-1");
    await manager.post("/products", { name: "Money Product", sku: "SKU-MONEY", unitPrice: "7.5", minimumStock: "0", initialStock: "0", unit: "pc" });
    const product = await Product.findOne({ where: { sku: "SKU-MONEY" } });
    assert.ok(product, "product created");
    await manager.post(`/products/${product.id}/update`, { name: "Money Product", sku: "SKU-MONEY", unitPrice: "8", minimumStock: "0", unit: "pc" });

    const supplier = await Supplier.create({ name: "Money Supplier" });
    await manager.post("/purchase-orders", { supplierId: supplier.id, productId: product.id, quantity: "2", unitPrice: "12.5" });
    const order = await PurchaseOrder.findOne({ where: { SupplierId: supplier.id } });
    await manager.post(`/purchase-orders/${order.id}/items`, { productId: product.id, quantity: "1", unitPrice: "3" });
    await manager.post(`/purchase-orders/${order.id}/status`, { status: "approved" });
    const line = await PurchaseOrderItem.findOne({ where: { PurchaseOrderId: order.id, unitPrice: "12.50" } });
    await manager.post(`/purchase-orders/${order.id}/receive`, { itemId: line.id, quantity: "2" });

    const accounting = (await (await api("/accounting/outbox?limit=500", accountingToken)).json()).data
      .filter(event => event.data.orderNumber === order.orderNumber);
    const byType = type => accounting.find(event => event.eventType === type).data;
    assert.deepEqual(byType("PurchaseOrderCreated").items[0].unitPrice, "12.50");
    assert.deepEqual(byType("PurchaseOrderUpdated").addedItem.unitPrice, "3.00");
    assert.deepEqual(byType("PurchaseOrderApproved").items.map(item => item.unitPrice).sort(), ["12.50", "3.00"]);
    assert.equal(byType("GoodsReceiptRecorded").unitCost, "12.50");
    assert.equal(byType("GoodsReceiptRecorded").receivedCost, "25.00");

    const crm = (await (await api("/crm/outbox?limit=500", crmToken)).json()).data
      .filter(event => event.data.productId === product.id);
    assert.equal(crm.find(event => event.eventType === "ProductCreated").data.price, "7.50");
    const priceChange = crm.find(event => event.eventType === "ProductPriceUpdated").data;
    assert.deepEqual([priceChange.previousPrice, priceChange.newPrice, priceChange.price], ["7.50", "8.00", "8.00"]);

    // Every money field in both outboxes, not just these events.
    const all = [
      ...(await (await api("/accounting/outbox?limit=500", accountingToken)).json()).data,
      ...(await (await api("/crm/outbox?limit=500", crmToken)).json()).data
    ];
    const moneyKeys = new Set(["price", "unitPrice", "unitCost", "receivedCost", "previousPrice", "newPrice"]);
    const check = (value, path) => {
      if (Array.isArray(value)) return value.forEach((item, i) => check(item, `${path}[${i}]`));
      if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          if (moneyKeys.has(key)) assert.match(String(inner), /^\d+\.\d{2}$/, `${path}.${key}`);
          if (moneyKeys.has(key)) assert.equal(typeof inner, "string", `${path}.${key}`);
          check(inner, `${path}.${key}`);
        }
      }
    };
    all.forEach(event => check(event.data, event.eventType));
  });

  test("stock movements over HTTP: staff may stock in/out but not adjust; managers may adjust", async () => {
    await startServer();
    const product = await makeProduct("SKU-PERM", 10);
    const staffRole = await Role.findOne({ where: { name: "staff" } });
    await User.create({
      name: "Local Staff", email: "local.staff@johnvivz.test", password: await bcrypt.hash("staff-password-1", 4),
      RoleId: staffRole.id, role: "staff", isActive: true, activatedAt: new Date()
    });
    const movements = () => StockMovement.count({ where: { ProductId: product.id } });

    const staff = await browser("local.staff@johnvivz.test", "staff-password-1");
    assert.ok(!staff.html.includes("/inventory/adjustment"), "staff do not see the adjust button");
    const adjust = await staff.post("/inventory/movements/adjustment", { productId: product.id, quantity: 3 });
    assert.equal(adjust.status, 302);
    assert.equal(adjust.headers.get("location"), "/inventory");
    assert.equal(await movements(), 0, "staff adjustment rejected");
    assert.equal((await staff.post("/inventory/movements/stock-in", { productId: product.id, quantity: 2 })).status, 302);
    assert.equal((await staff.post("/inventory/movements/stock-out", { productId: product.id, quantity: 1 })).status, 302);
    assert.equal(await movements(), 2);

    const manager = await browser("admin@johnvivz.test", "manager-password-1");
    assert.ok(manager.html.includes("/inventory/adjustment"));
    await manager.post("/inventory/movements/adjustment", { productId: product.id, quantity: 4 });
    assert.equal(await movements(), 3);
    assert.equal((await Inventory.findOne({ where: { ProductId: product.id } })).quantity, 4);
  });
}
