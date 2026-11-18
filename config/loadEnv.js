// Loads settings from the project's .env file before any other module reads process.env.
// Values already present in the real environment win over the file.
// The file is ignored under `node --test` (NODE_TEST_CONTEXT) or with INVENTORY_SKIP_DOTENV=1,
// so tests never pick up real tokens.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

if (process.env.INVENTORY_SKIP_DOTENV !== "1" && !process.env.NODE_TEST_CONTEXT && fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
