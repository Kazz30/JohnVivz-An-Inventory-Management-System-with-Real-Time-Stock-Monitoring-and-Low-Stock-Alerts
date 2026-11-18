// Manage per-system integration tokens.
//   npm run token -- create crm "CRM production"
//   npm run token -- create accounting "JVzPay production"
//   npm run token -- list
//   npm run token -- revoke <id>
// The token is printed ONCE on create; only its SHA-256 hash is stored.
import "../config/loadEnv.js";
import { IntegrationToken, sequelize } from "../models/index.js";
import {
  INTEGRATION_SYSTEMS, createIntegrationToken, listIntegrationTokens, revokeIntegrationToken
} from "../services/integrationTokens.js";

const usage = `Usage:
  npm run token -- create <${INTEGRATION_SYSTEMS.join("|")}> "<name>"
  npm run token -- list
  npm run token -- revoke <id>`;

const [command, ...args] = process.argv.slice(2);

try {
  await sequelize.authenticate();
  await IntegrationToken.sync(); // creates the new table if this runs before the first app start
  if (command === "create") {
    const [system, ...nameParts] = args;
    const { token, record } = await createIntegrationToken({ system, name: nameParts.join(" ") });
    console.log(`Created ${record.system} token #${record.id} "${record.name}".`);
    console.log("Copy it now; it cannot be shown again:");
    console.log(token);
  } else if (command === "list") {
    const tokens = await listIntegrationTokens();
    if (!tokens.length) console.log("No integration tokens.");
    for (const t of tokens) {
      console.log([
        `#${t.id}`, t.system, `"${t.name}"`, `${t.tokenPrefix}…`,
        t.revokedAt ? `REVOKED ${t.revokedAt.toISOString()}` : "active",
        `last used ${t.lastUsedAt ? t.lastUsedAt.toISOString() : "never"}`
      ].join("  "));
    }
  } else if (command === "revoke") {
    if (!args[0]) throw new Error(usage);
    console.log(await revokeIntegrationToken(args[0])
      ? `Token #${args[0]} revoked. It stops working immediately.`
      : `No active token #${args[0]}.`);
  } else {
    console.log(usage);
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
