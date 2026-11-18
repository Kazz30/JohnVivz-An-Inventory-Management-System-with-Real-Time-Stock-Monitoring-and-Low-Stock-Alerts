const allowedEventTypes = new Set([
  "order.confirmed",
  "sale.completed",
  "order.cancelled",
  "sale.refunded",
  "return.received"
]);

const requestError = message => {
  const error = new Error(message);
  error.status = 400;
  return error;
};

const requiredReference = (value, label, maxLength) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw requestError(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
};

const validateItems = items => {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw requestError("Items must contain between 1 and 100 products.");
  }
  const seenProductIds = new Set();
  return items.map(item => {
    const productId = Number(item?.productId);
    const quantity = Number(item?.quantity);
    if (!Number.isSafeInteger(productId) || productId < 1 ||
        !Number.isSafeInteger(quantity) || quantity < 1) {
      throw requestError("Each item must have a positive integer productId and quantity.");
    }
    if (seenProductIds.has(productId)) throw requestError("Each product may appear only once in an event.");
    seenProductIds.add(productId);
    return { productId, quantity };
  });
};

export const validateCrmEvent = input => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw requestError("The event body must be a JSON object.");
  }
  const eventId = requiredReference(input.eventId, "eventId", 120);
  const eventType = requiredReference(input.eventType, "eventType", 80);
  if (!allowedEventTypes.has(eventType)) throw requestError("Unsupported CRM event type.");
  const allowedFields = new Set(["eventId", "eventType"]);
  if (["order.confirmed", "sale.completed", "order.cancelled", "sale.refunded"].includes(eventType)) {
    allowedFields.add("orderReference");
  }
  if (["sale.completed", "sale.refunded", "return.received"].includes(eventType)) {
    allowedFields.add("transactionReference");
  }
  if (["order.confirmed", "return.received"].includes(eventType)) allowedFields.add("items");
  if (Object.keys(input).some(key => !allowedFields.has(key))) {
    throw requestError("The event contains unsupported fields.");
  }

  const event = { eventId, eventType };
  if (["order.confirmed", "sale.completed", "order.cancelled", "sale.refunded"].includes(eventType)) {
    event.orderReference = requiredReference(input.orderReference, "orderReference", 120);
  }
  if (["sale.completed", "sale.refunded", "return.received"].includes(eventType)) {
    event.transactionReference = requiredReference(input.transactionReference, "transactionReference", 140);
  }
  if (["order.confirmed", "return.received"].includes(eventType)) {
    event.items = validateItems(input.items);
  }
  return event;
};

export const makeExternalReference = (kind, transactionReference, productId) =>
  `${kind}:${transactionReference}:${productId}`;
