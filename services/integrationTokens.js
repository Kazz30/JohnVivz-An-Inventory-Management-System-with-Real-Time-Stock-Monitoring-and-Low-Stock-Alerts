// Per-system integration tokens (CRM, Accounting). Tokens are 256-bit random values, so a
// plain SHA-256 hash is enough to store them safely; bcrypt-style slow hashing is for
// human passwords and would only slow every API call.
import { createHash, randomBytes } from "node:crypto";
import { IntegrationToken } from "../models/index.js";

export const INTEGRATION_SYSTEMS = ["crm", "accounting"];

// Which routes each system may call (enforced in middleware/integrationAuth.js):
//   crm:        /products*, POST /events, /crm/outbox and its acks
//   accounting: /accounting/outbox and its acks
export const hashIntegrationToken = token => createHash("sha256").update(String(token), "utf8").digest("hex");

export const createIntegrationToken = async ({ system, name }) => {
  if (!INTEGRATION_SYSTEMS.includes(system)) throw new Error(`System must be one of: ${INTEGRATION_SYSTEMS.join(", ")}.`);
  const label = String(name || "").trim();
  if (!label || label.length > 120) throw new Error("Give the token a name of 1 to 120 characters.");
  const token = `jvi_${system}_${randomBytes(32).toString("base64url")}`;
  const record = await IntegrationToken.create({
    name: label,
    system,
    tokenHash: hashIntegrationToken(token),
    tokenPrefix: token.slice(0, system.length + 9)
  });
  return { token, record };
};

export const listIntegrationTokens = () => IntegrationToken.findAll({
  attributes: ["id", "name", "system", "tokenPrefix", "createdAt", "lastUsedAt", "revokedAt"],
  order: [["id", "ASC"]]
});

export const revokeIntegrationToken = async id => {
  const [updated] = await IntegrationToken.update(
    { revokedAt: new Date() },
    { where: { id: Number(id), revokedAt: null } }
  );
  return updated === 1;
};

// Returns the active (not revoked) token record for a presented token, or null.
export const findActiveIntegrationToken = async token => {
  if (!token) return null;
  const record = await IntegrationToken.findOne({ where: { tokenHash: hashIntegrationToken(token), revokedAt: null } });
  if (record && (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > 60_000)) {
    record.update({ lastUsedAt: new Date() }).catch(error => console.error("Unable to record token use:", error.message));
  }
  return record;
};
