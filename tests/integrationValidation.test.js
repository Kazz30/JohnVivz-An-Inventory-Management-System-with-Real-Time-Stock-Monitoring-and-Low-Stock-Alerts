import test from "node:test";
import assert from "node:assert/strict";
import { makeExternalReference, validateCrmEvent } from "../services/integrationValidation.js";

test("validates and normalizes a CRM stock reservation event", () => {
  const event = validateCrmEvent({
    eventId: "  crm-event-1 ",
    eventType: "order.confirmed",
    orderReference: " order-100 ",
    items: [{ productId: "12", quantity: "3" }]
  });

  assert.deepEqual(event, {
    eventId: "crm-event-1",
    eventType: "order.confirmed",
    orderReference: "order-100",
    items: [{ productId: 12, quantity: 3 }]
  });
});

test("rejects duplicate products and invalid quantities", () => {
  assert.throws(() => validateCrmEvent({
    eventId: "event-1",
    eventType: "order.confirmed",
    orderReference: "order-1",
    items: [{ productId: 1, quantity: 1 }, { productId: 1, quantity: 2 }]
  }), /only once/);

  assert.throws(() => validateCrmEvent({
    eventId: "event-2",
    eventType: "return.received",
    transactionReference: "return-1",
    items: [{ productId: 1, quantity: 0 }]
  }), /positive integer/);
});

test("requires transaction references for deductions and returns", () => {
  assert.throws(() => validateCrmEvent({
    eventId: "event-3",
    eventType: "sale.completed",
    orderReference: "order-1"
  }), /transactionReference/);

  assert.throws(() => validateCrmEvent({
    eventId: "event-4",
    eventType: "return.received",
    transactionReference: "return-1",
    items: []
  }), /between 1 and 100/);
});

test("rejects unsupported event types and malformed IDs", () => {
  assert.throws(() => validateCrmEvent({
    eventId: "event-5",
    eventType: "purchase.created"
  }), /Unsupported/);

  assert.throws(() => validateCrmEvent({
    eventId: "",
    eventType: "order.cancelled",
    orderReference: "order-2"
  }), /eventId/);
});

test("rejects unsupported event fields", () => {
  assert.throws(() => validateCrmEvent({
    eventId: "event-6",
    eventType: "order.cancelled",
    orderReference: "order-3",
    price: 99
  }), /unsupported fields/);
});

test("external stock references distinguish product lines", () => {
  assert.equal(makeExternalReference("sale", "txn-17", 4), "sale:txn-17:4");
  assert.notEqual(makeExternalReference("sale", "txn-17", 4), makeExternalReference("sale", "txn-17", 5));
});

