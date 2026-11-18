import test from "node:test";
import assert from "node:assert/strict";
import router from "../routes/index.js";
import { formatMoney, multiplyMoney, parseMoney } from "../services/money.js";
import {
  outboxTargetSystems, requireCrmToken, requireIntegrationToken, requireOutboxToken
} from "../middleware/integrationAuth.js";
import { hashIntegrationToken } from "../services/integrationTokens.js";

test("money becomes an exact two-decimal string", () => {
  assert.equal(parseMoney("12.5"), "12.50");
  assert.equal(parseMoney(" 3 "), "3.00");
  assert.equal(parseMoney("12.345"), "12.35", "half-up like MySQL DECIMAL(12,2)");
  assert.equal(parseMoney("1.005"), "1.01", "no float error");
  assert.equal(parseMoney("0.999"), "1.00");
  assert.equal(parseMoney(12.5), "12.50");
  assert.equal(parseMoney("9999999999.99"), "9999999999.99");
  for (const bad of ["", "-1", "1e3", "0x10", "abc", "12,50", "99999999999", null, undefined, -2, NaN]) {
    assert.equal(parseMoney(bad), null, String(bad));
  }
  assert.equal(formatMoney("12.50"), "12.50");
  assert.throws(() => formatMoney("x"));
  assert.equal(multiplyMoney("12.50", 3), "37.50");
  assert.equal(multiplyMoney("0.10", 3), "0.30");
});

test("tokens are stored as SHA-256 hashes", () => {
  assert.match(hashIntegrationToken("jvi_crm_abc"), /^[0-9a-f]{64}$/);
  assert.notEqual(hashIntegrationToken("a"), hashIntegrationToken("b"));
});

const run = async (middleware, { authorization, target } = {}) => {
  let result = { passed: false, status: null };
  const req = { get: () => authorization, params: { target } };
  await middleware(req, {}, error => { result = error ? { passed: false, status: error.status } : { passed: true, client: req.integrationClient }; });
  return result;
};
const tokens = { "crm-secret": { id: 1, system: "crm", name: "CRM" }, "acc-secret": { id: 2, system: "accounting", name: "JVzPay" } };
const findToken = async token => tokens[token] || null;

test("each token only works on its own system's routes (401 unknown, 403 wrong system)", async () => {
  const crmOnly = requireIntegrationToken(["crm"], { findToken });
  const outbox = requireIntegrationToken(outboxTargetSystems, { findToken });

  assert.equal((await run(crmOnly, {})).status, 401);
  assert.equal((await run(crmOnly, { authorization: "Basic x" })).status, 401);
  assert.equal((await run(crmOnly, { authorization: "Bearer revoked-or-unknown" })).status, 401);
  assert.equal((await run(crmOnly, { authorization: "Bearer crm-secret" })).passed, true);
  assert.equal((await run(crmOnly, { authorization: "Bearer acc-secret" })).status, 403);

  assert.equal((await run(outbox, { authorization: "Bearer crm-secret", target: "accounting" })).status, 403);
  assert.equal((await run(outbox, { authorization: "Bearer acc-secret", target: "crm" })).status, 403);
  assert.equal((await run(outbox, { authorization: "Bearer acc-secret", target: "accounting" })).passed, true);
  assert.equal((await run(outbox, { authorization: "Bearer crm-secret", target: "crm" })).passed, true);
  assert.equal((await run(outbox, { authorization: "Bearer crm-secret", target: "nope" })).passed, true, "controller answers 404");
});

test("every integration route has a system-scoped guard", () => {
  const guard = (path, method) => router.stack
    .find(layer => layer.route?.path === path && layer.route.methods[method])
    .route.stack[0].handle;
  for (const path of ["/api/integration/v1/products", "/api/integration/v1/products/:id",
    "/api/integration/v1/products/:id/availability", "/api/integration/v1/products/:id/price"]) {
    assert.equal(guard(path, "get"), requireCrmToken, path);
  }
  assert.equal(guard("/api/integration/v1/events", "post"), requireCrmToken);
  assert.equal(guard("/api/integration/v1/:target/outbox", "get"), requireOutboxToken);
  assert.equal(guard("/api/integration/v1/:target/outbox/:eventId/ack", "post"), requireOutboxToken);
});
