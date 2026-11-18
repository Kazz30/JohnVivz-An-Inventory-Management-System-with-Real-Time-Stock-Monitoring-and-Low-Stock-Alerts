import test from "node:test";
import assert from "node:assert/strict";
import { callJvzpayLogin } from "../services/jvzpayClient.js";

const settings = { jvzpayApiUrl: "http://pay.test", jvzpayApiToken: "pay-token", externalRequestTimeoutMs: 200 };
const respond = (status, body) => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const ok = {
  employee_id: "JV-2026-00001", employee_code: "C1", full_name: "A", email: "a@x.com", department_code: "INV",
  department_name: "Inventory", position: "Clerk", employment_status: "Active", ess_registered_at: "2026-11-01"
};

test("posts email and password to the department login with the JVzPay token", async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return new Response(JSON.stringify(ok), { status: 200 });
  };
  const result = await callJvzpayLogin({ email: "a@x.com", password: "secret-pass", settings, fetchImpl });
  assert.equal(result.kind, "ok");
  assert.equal(result.employee.employee_id, "JV-2026-00001");
  assert.equal(seen.url, "http://pay.test/api/integration/v1/auth/login");
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.headers.authorization, "Bearer pay-token");
  assert.deepEqual(JSON.parse(seen.options.body), { email: "a@x.com", password: "secret-pass" });
});

test("maps JVzPay answers to rejected or unavailable", async () => {
  const call = fetchImpl => callJvzpayLogin({ email: "a@x.com", password: "p", settings, fetchImpl });
  assert.equal((await call(respond(401, { error: "invalid_credentials" }))).kind, "rejected");
  assert.equal((await call(respond(403, { error: "not_allowed" }))).kind, "rejected");
  assert.equal((await call(respond(400, { error: "bad" }))).kind, "rejected");
  assert.equal((await call(respond(401, { error: "Invalid bearer token" }))).reason, "jvzpay_token_rejected");
  assert.equal((await call(respond(500, {}))).kind, "unavailable");
  assert.equal((await call(respond(503, {}))).kind, "unavailable");
  assert.equal((await call(respond(200, "not json"))).kind, "unavailable");
  assert.equal((await call(async () => { throw new TypeError("fetch failed"); })).kind, "unavailable");
  const hang = (url, options) => new Promise((resolve, reject) =>
    options.signal.addEventListener("abort", () => reject(options.signal.reason)));
  assert.equal((await call(hang)).reason, "jvzpay_unreachable");
});

test("missing JVzPay settings count as unavailable", async () => {
  const result = await callJvzpayLogin({ email: "a@x.com", password: "p", settings: { ...settings, jvzpayApiToken: "" } });
  assert.deepEqual(result, { kind: "unavailable", reason: "jvzpay_not_configured" });
});
