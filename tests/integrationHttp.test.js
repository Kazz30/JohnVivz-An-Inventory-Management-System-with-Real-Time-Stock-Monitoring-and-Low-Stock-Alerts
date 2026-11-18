import test from "node:test";
import assert from "node:assert/strict";
import app from "../index.js";

test("integration routes return JSON and rely on bearer authentication instead of browser CSRF", async t => {
  const server = await new Promise(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/integration/v1`;

  const productResponse = await fetch(`${baseUrl}/products`);
  assert.equal(productResponse.status, 401);
  assert.match(productResponse.headers.get("content-type"), /application\/json/);

  const eventResponse = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: "test-event", eventType: "order.cancelled", orderReference: "test-order" })
  });
  assert.equal(eventResponse.status, 401);
  assert.match(eventResponse.headers.get("content-type"), /application\/json/);
});
