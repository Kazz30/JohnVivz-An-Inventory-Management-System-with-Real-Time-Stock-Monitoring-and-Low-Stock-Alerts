/*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
    
import "./config/loadEnv.js";
import express from "express";
import path from "path";
import session from "express-session";
import flash from "connect-flash";
import router from "./routes/index.js";
import fs from 'fs';
import hbs from "hbs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { sequelize, Role } from "./models/index.js";
import { loadCurrentUser } from "./middleware/auth.js";
import {
  ensureApplicationIndexes, ensureEssLoginSchema, ensureHrIntegrationSchema, ensureIntegrationSchema, migrateLegacyUsers
} from "./models/legacyMigration.js";
import { getSettings } from "./config/settings.js";
import { startHrSyncScheduler } from "./services/hrSyncService.js";
import { SequelizeSessionStore } from "./models/sessionStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const cryptoRandomToken = () => randomBytes(32).toString("hex");
const hbsEngine = hbs.handlebars;
hbsEngine.registerHelper("isAdmin", role => role === "manager");
hbsEngine.registerHelper("canReviewReports", role => ["manager", "supervisor"].includes(role));
hbsEngine.registerHelper("isActive", (value, expected) => String(value) === String(expected));
hbsEngine.registerHelper("isSelect", value => value === "select");
hbsEngine.registerHelper("isRead", value => value === "Read");
hbsEngine.registerHelper("tableColumnCount", (columns, actions) => (columns?.length || 0) + (actions ? 1 : 0));
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === "production" ? "" : "development-only-change-this-secret");
if (!sessionSecret) throw new Error("SESSION_SECRET must be set in production.");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), "public")));

app.use(session({
  name: "johnvivz.sid",
  secret: sessionSecret,
  store: new SequelizeSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
}));
app.use(flash());
app.use(loadCurrentUser);

app.engine("xian", async (filePath, options, callback) => {
  try {
     const originalPartialsDir = hbs.partialsDir;
    hbs.partialsDir = path.join(__dirname, 'views');

    const result = await new Promise((resolve, reject) => {
      hbs.__express(filePath, options, (err, html) => {
        if (err) return reject(err);
        resolve(html);
      });
    });

    hbs.partialsDir = originalPartialsDir;
    callback(null, result);
  } catch (err) {
    callback(err);
  }
});
app.use((req, res, next) => {
  if (req.path.startsWith("/api/integration/v1/")) return next();
  res.locals.success_msg = req.flash("success_msg");
  res.locals.error_msg = req.flash("error_msg");
  if (!req.session.csrfToken) req.session.csrfToken = cryptoRandomToken();
  res.locals.csrfToken = req.session.csrfToken;
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith("/api/integration/v1/")) return next();
  if (req.method !== "POST" || ["/login", "/register"].includes(req.path)) return next();
  const submitted = Buffer.from(String(req.body._csrf || ""));
  const expected = Buffer.from(String(req.session.csrfToken || ""));
  if (!submitted.length || submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) {
    const error = new Error("Your session token expired. Refresh the page and try again.");
    error.status = 403;
    return next(error);
  }
  next();
});


app.set("views", path.join(__dirname, "views"));
app.set("view engine", "xian");
const partialsDir = path.join(__dirname, "views/partials");
for (const file of fs.readdirSync(partialsDir).filter(name => name.endsWith(".xian"))) {
  hbs.registerPartial(file.replace(".xian", ""), fs.readFileSync(path.join(partialsDir, file), "utf8"));
}

app.use("/", router);
app.use((req, res) => res.status(404).send("Page not found."));
app.use((error, req, res, next) => {
  console.error(error);
  const status = error.status || (
    error.name === "Error" || error.name?.includes("Validation") ||
    error.name?.includes("UniqueConstraint") || error.name?.includes("ForeignKeyConstraint") ? 400 : 500
  );
  const clientError = status >= 400 && status < 500;
  const message = clientError ? error.message : "Something went wrong while processing your request.";
  if (req.path.startsWith("/api/integration/v1/")) {
    const body = { error: message };
    // Business conflicts carry a stable code and details (e.g. insufficient_stock shortages).
    if (clientError && error.status && typeof error.code === "string") body.code = error.code;
    if (clientError && error.status && error.details !== undefined) body.details = error.details;
    return res.status(status).json(body);
  }
  if ((status === 400 || status === 403) && req.accepts("html")) {
    if (typeof req.flash === "function") req.flash("error_msg", message);
    return res.redirect(req.user ? "/dashboard" : "/login");
  }
  if (req.accepts("html")) return res.status(status).send(message);
  res.status(status).json({ error: message });
});

export default app;

// Start the HTTP server; resolves once the server is listening.
// Exported so the Electron main process can control startup itself.
export const startServer = (port = PORT) => {
  return (async () => {
    await sequelize.authenticate();
    await ensureHrIntegrationSchema();
    for (const sql of await ensureEssLoginSchema()) console.log(`Applied schema change: ${sql}`);
    await sequelize.sync();
    await migrateLegacyUsers();
    await Promise.all([
      Role.findOrCreate({ where: { name: "manager" } }),
      Role.findOrCreate({ where: { name: "supervisor" } }),
      Role.findOrCreate({ where: { name: "staff" } })
    ]);
    await ensureIntegrationSchema();
    await ensureApplicationIndexes();
    const settings = getSettings();
    if (settings.essLoginModeInvalid) console.warn(`ESS_LOGIN_MODE must be "local" or "live"; using "local".`);
    if (settings.essLoginMode === "live" && (!settings.jvzpayApiUrl || !settings.jvzpayApiToken || !settings.inventoryDepartmentCode)) {
      console.warn("ESS_LOGIN_MODE=live but JVZPAY_API_URL, JVZPAY_API_TOKEN or INVENTORY_DEPARTMENT_CODE is missing; only the emergency admin can sign in.");
    }
    console.log(`Sign-in mode: ${settings.essLoginMode}.`);
    if (process.env.INVENTORY_INTEGRATION_TOKEN) {
      console.warn("INVENTORY_INTEGRATION_TOKEN is no longer used. Create per-system tokens with: npm run token -- create crm|accounting \"<name>\"");
    }
    startHrSyncScheduler({ settings });
    return new Promise((resolve, reject) => {
      const server = app.listen(port, () => {
        console.log(`XianFire running at http://localhost:${port}`);
        resolve(server);
      });
      server.on("error", reject);
    });
  })();
};

// Auto-start only when executed directly (node index.js).
// When imported by electron/main.js, Electron manages the server lifecycle.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer().catch(error => {
    console.error("Unable to start JohnVivz:", error);
    process.exitCode = 1;
  });
}
