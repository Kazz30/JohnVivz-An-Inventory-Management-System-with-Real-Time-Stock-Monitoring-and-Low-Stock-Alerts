import test from "node:test";
import assert from "node:assert/strict";
import { createHrClient, normalizeEmployee, HrApiError } from "../services/hrClient.js";

const settings = { hrApiUrl: "http://hr.test", hrApiToken: "hr-key", externalRequestTimeoutMs: 1000 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const employee = n => ({
  permanent_employee_id: `JV-2026-${String(n).padStart(5, "0")}`, employee_code: `CODE-${n}`, full_name: `Person ${n}`,
  email: `Person${n}@Example.com`, department: { department_id: 7, department_name: "Inventory", department_code: "INV" },
  position: "Clerk", status: "Active", salary: 99999, birth_date: "1990-01-01", address: "secret"
});

test("reads every employee page with the HR bearer token and department filter", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), auth: options.headers.authorization });
    const page = Number(new URL(url).searchParams.get("page"));
    const items = page === 1 ? Array.from({ length: 100 }, (_, i) => employee(i + 1)) : [employee(101)];
    return json({ success: true, data: { items, page, page_size: 100, total: 101, total_pages: 2 } });
  };
  const result = await createHrClient({ settings, fetchImpl }).listEmployees({ departmentId: 7 });
  assert.equal(result.length, 101);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.auth === "Bearer hr-key"));
  assert.ok(calls.every(call => call.url.pathname === "/api/integration/v1/employees"));
  assert.ok(calls.every(call => call.url.searchParams.get("department_id") === "7"));
});

test("stops on a short page when HR sends no paging totals", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json({ success: true, data: { items: [employee(1)] } }); };
  assert.equal((await createHrClient({ settings, fetchImpl }).listEmployees()).length, 1);
  assert.equal(calls, 1);
});

test("a failed page fails the whole list (no partial sync)", async () => {
  const fetchImpl = async url => new URL(url).searchParams.get("page") === "1"
    ? json({ success: true, data: { items: Array.from({ length: 100 }, (_, i) => employee(i)), total_pages: 2 } })
    : json({ success: false }, 500);
  await assert.rejects(createHrClient({ settings, fetchImpl }).listEmployees(), HrApiError);
  const down = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(createHrClient({ settings, fetchImpl: down }).listDepartments(), /could not be reached/);
});

test("getEmployee returns null on 404", async () => {
  const client = createHrClient({ settings, fetchImpl: async () => json({ success: false }, 404) });
  assert.equal(await client.getEmployee("JV-2026-00001"), null);
});

test("normalized employees keep only identity, department, position and status", () => {
  const normalized = normalizeEmployee(employee(3));
  assert.deepEqual(Object.keys(normalized).sort(),
    ["departmentCode", "departmentId", "email", "employeeId", "fullName", "position", "status"]);
  assert.equal(normalized.email, "person3@example.com");
  assert.equal(normalizeEmployee({ ...employee(4), email: "not-an-email" }), null);
  assert.equal(normalizeEmployee({ ...employee(5), permanent_employee_id: "" }), null);
});
