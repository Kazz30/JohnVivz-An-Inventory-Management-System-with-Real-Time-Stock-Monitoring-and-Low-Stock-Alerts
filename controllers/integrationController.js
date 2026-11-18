import {
  acknowledgeOutboxEvent, getProduct, listOutboxEvents, listProducts, receiveCrmEvent
} from "../services/integrationService.js";

const notFound = res => res.status(404).json({ error: "Product not found." });

export const products = async (req, res) => {
  const search = String(req.query.search || "").trim();
  if (search.length > 100) {
    return res.status(400).json({ error: "Search text must be 100 characters or fewer." });
  }
  const requestedLimit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  const requestedOffset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 ||
      !Number.isInteger(requestedOffset) || requestedOffset < 0) {
    return res.status(400).json({ error: "limit and offset must be non-negative integers; limit must be at least one." });
  }
  const limit = Math.min(requestedLimit, 200);
  const data = await listProducts({ search, limit, offset: requestedOffset });
  res.json({ data, pagination: { limit, offset: requestedOffset } });
};

export const product = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return notFound(res);
  const result = await getProduct(id);
  if (!result) return notFound(res);
  res.json({ data: result });
};

export const availability = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return notFound(res);
  const result = await getProduct(id);
  if (!result) return notFound(res);
  res.json({
    data: {
      productId: result.id,
      sku: result.sku,
      physicalStock: result.physicalStock,
      reservedStock: result.reservedStock,
      availableStock: result.availableStock,
      status: result.availableStock <= 0 ? "unavailable" : "available"
    }
  });
};

export const price = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return notFound(res);
  const result = await getProduct(id);
  if (!result) return notFound(res);
  res.json({ data: { productId: result.id, sku: result.sku, price: result.price } });
};

export const receiveEvent = async (req, res) => {
  const result = await receiveCrmEvent(req.body);
  res.status(result.duplicate ? 200 : 202).json(result);
};

export const outbox = async (req, res) => {
  const target = req.params.target;
  if (!["crm", "accounting"].includes(target)) {
    return res.status(404).json({ error: "Integration target not found." });
  }
  const requestedLimit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    return res.status(400).json({ error: "limit must be a positive integer." });
  }
  const events = await listOutboxEvents(target, Math.min(requestedLimit, 500));
  res.json({ data: events });
};

export const acknowledgeEvent = async (req, res) => {
  const { target, eventId } = req.params;
  if (!["crm", "accounting"].includes(target)) {
    return res.status(404).json({ error: "Integration target not found." });
  }
  const acknowledged = await acknowledgeOutboxEvent(target, eventId);
  if (!acknowledged) return res.status(404).json({ error: "Pending integration event not found." });
  res.json({ eventId, acknowledged: true });
};
