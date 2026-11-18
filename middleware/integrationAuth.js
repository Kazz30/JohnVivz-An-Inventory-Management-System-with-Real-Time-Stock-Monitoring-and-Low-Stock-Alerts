import { INTEGRATION_SYSTEMS, findActiveIntegrationToken } from "../services/integrationTokens.js";

const fail = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

// requireIntegrationToken(["crm"]) or requireIntegrationToken(req => [...]).
//   401: no bearer token, unknown token, or revoked token.
//   403: a valid token from a system that may not use this route.
export const requireIntegrationToken = (allowed, { findToken = findActiveIntegrationToken } = {}) =>
  async (req, res, next) => {
    try {
      const match = /^Bearer ([^\s]+)$/.exec(String(req.get("authorization") || ""));
      if (!match) return next(fail(401, "A valid integration bearer token is required."));
      const record = await findToken(match[1]);
      if (!record) return next(fail(401, "A valid integration bearer token is required."));
      const systems = typeof allowed === "function" ? allowed(req) : allowed;
      if (!systems.includes(record.system)) {
        return next(fail(403, "This integration token is not allowed to use this route."));
      }
      req.integrationClient = { id: record.id, system: record.system, name: record.name };
      next();
    } catch (error) {
      next(error);
    }
  };

// /:target/outbox routes: a token may only read and acknowledge its own system's outbox.
// For an unknown target any valid token passes, so the controller can answer 404.
export const outboxTargetSystems = req =>
  INTEGRATION_SYSTEMS.includes(req.params.target) ? [req.params.target] : INTEGRATION_SYSTEMS;

export const requireCrmToken = requireIntegrationToken(["crm"]);
export const requireOutboxToken = requireIntegrationToken(outboxTargetSystems);
