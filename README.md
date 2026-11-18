# JohnVivz Inventory Management

JohnVivz is an Express/XianFire application using `.xian` (Handlebars-compatible) views, Sequelize, and MySQL, following the [official XianFire framework documentation](https://github.com/chalsimos/xianfire#readme). It provides manager, supervisor, and staff accounts with role-specific dashboards, product and supplier management, inventory movements and reservations, purchase orders, stock alerts, notifications, and reports.

## Run locally

Requirements: Node.js, MySQL, and a MySQL account allowed to create the project database.

```powershell
npm install
$env:DB_HOST = "localhost"
$env:DB_PORT = "3306"
$env:DB_NAME = "JohnVivz_Invntry_System"
$env:DB_USER = "root"
$env:DB_PASSWORD = ""
$env:SESSION_SECRET = "replace-with-a-long-random-secret"
npm run migrate
npm start
```

Open `http://localhost:3000/register` to create the first inventory manager. After that, create manager, supervisor, and staff accounts from **User management**. The registration route is disabled after initial setup.

For development, `npm run dev` starts the XianFire server with Nodemon. Settings are read from the environment or from a `.env` file in the project root (copy `.env.example`; real environment variables win).

## Inventory behavior

- Inventory and product stock quantities are changed together inside a Sequelize transaction.
- Stock out cannot exceed available quantity. Adjustments use the newly counted on-hand quantity.
- Every stock change writes an immutable stock movement.
- Active low-stock alerts are deduplicated and resolved after a replenishment moves stock above the threshold.
- Purchase-order deliveries add only the received quantity and update the order item, inventory, movement history, and alert state in the same transaction.
- Sessions and notifications are stored in MySQL; passwords are hashed and role checks and CSRF validation are enforced server-side.

## Integrations

The authenticated CRM and Accounting API contract, event names, and retry behavior are documented in [docs/api.md](./docs/api.md). Each caller (CRM, Accounting) gets its own token, limited to its own routes: `npm run token -- create crm "CRM production"`, `npm run token -- list`, `npm run token -- revoke <id>`. Only token hashes are stored. Requests without a valid token get `401`; a token used on another system's route gets `403`.

Employee accounts come from HR: a sync every 5 minutes (plus **Sync now** on User management) creates deactivated accounts for the Inventory department, and with `ESS_LOGIN_MODE=live` staff sign in with their ESS (JVzPay) password. The first successful sign-in activates the account. See [docs/deployment.md](./docs/deployment.md#employee-accounts-hr-sync-and-ess-sign-in).

Stock in and stock out are limited to staff, supervisors and managers; stock adjustments are manager-only.

Architecture diagrams are in [docs/architecture.md](./docs/architecture.md), and environment and deployment steps are in [docs/deployment.md](./docs/deployment.md).

## Tests

Run the tests with `npm test`. Database-backed tests (HR sync, sign-in, CRM reservations, stock permissions, the schema change) run only when `TEST_DB_NAME` names a throwaway MySQL database ending in `_test`, e.g. `$env:TEST_DB_NAME = "johnvivz_inventory_test"; npm test`.

Tailwind CSS, Chart.js, and Lucide icons are loaded from their public CDNs; the application layout and responsive styles are in `public/app.css`.
