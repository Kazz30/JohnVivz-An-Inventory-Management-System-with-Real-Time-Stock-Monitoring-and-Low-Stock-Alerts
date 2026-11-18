# Inventory app integration report

This report is based only on the code in this repository. The file `docs/integration-contract.md` was not found in the project; the closest matching documents are `docs/api.md` and `docs/architecture.md`.

## 1. App basics

- App name: JohnVivz Inventory Management
- Framework and version: XianFire / Express-based project. The project uses Express 4.19.2 and the XianFire conventions from the official framework docs. No exact XianFire version is declared in the package files.
- Node version needed: A supported Node.js LTS release is required according to `docs/deployment.md`. No exact minimum version is pinned in this repo.
- Port: `PORT` environment variable, default `3000`.
- Listen address: The app calls `app.listen(port)` in `index.js`, which binds to the default Node server host (effectively all interfaces, not localhost-only).
- Database: MySQL, using Sequelize with the `mysql2` driver. The default database name is `JohnVivz_Invntry_System`.
- Local database stack: The app is compatible with a local MySQL server such as Laragon or XAMPP; the code does not hard-code either one.
- Install and start commands from a fresh copy:

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

For development, `npm run dev` starts the app with Nodemon.

## 2. All routes / endpoints

| Method | URL path | Controller/function | Login or auth needed? | What it does | Returns HTML page or JSON? |
|---|---|---|---|---|---|
| GET | `/api/integration/v1/products` | `integration.products` | token | List active products with search, limit, and offset filters | JSON |
| GET | `/api/integration/v1/products/:id` | `integration.product` | token | Read one product record by id | JSON |
| GET | `/api/integration/v1/products/:id/availability` | `integration.availability` | token | Return on-hand, reserved, and available stock | JSON |
| GET | `/api/integration/v1/products/:id/price` | `integration.price` | token | Return the official selling price | JSON |
| POST | `/api/integration/v1/events` | `integration.receiveEvent` | token | Receive CRM order/sale/return events and apply stock changes | JSON |
| GET | `/api/integration/v1/:target/outbox` | `integration.outbox` | token | List pending durable outbound events for CRM or Accounting | JSON |
| POST | `/api/integration/v1/:target/outbox/:eventId/ack` | `integration.acknowledgeEvent` | token | Mark an outbound event as acknowledged | JSON |
| GET | `/` | `homePage` | none | Dashboard landing page | HTML |
| GET | `/login` | `loginPage` | none | Login screen | HTML |
| POST | `/login` | `loginUser` | none | Authenticate a user and create a session | HTML redirect |
| GET | `/register` | `registerPage` | none | First-time user registration page | HTML |
| POST | `/register` | `registerUser` | none | Create an initial manager account or register a user | HTML redirect |
| POST | `/logout` | `logoutUser` | session | End the user session | HTML redirect |
| GET | `/dashboard` | `dashboardPage` | session | Show the main dashboard | HTML |
| GET | `/profile` | `profilePage` | session | Show user profile | HTML |
| POST | `/profile` | `updateProfile` | session | Update profile | HTML redirect |
| GET | `/users` | `usersPage` | session + manager | See user management pages | HTML |
| GET | `/users/:id/edit` | `editUserPage` | session + manager | Edit a user | HTML |
| POST | `/users/:id/update` | `updateUser` | session + manager | Save user changes | HTML redirect |
| POST | `/users/:id/toggle` | `toggleUser` | session + manager | Enable or disable a user | HTML redirect |
| GET | `/products` | `inventory.productsPage` | session | List products and filters | HTML |
| POST | `/products` | `inventory.createProduct` | session + manager | Create a product and opening stock | HTML redirect |
| GET | `/products/:id` | `inventory.productDetailsPage` | session | Show product details and stock history | HTML |
| GET | `/products/:id/edit` | `inventory.editProductPage` | session + manager | Edit product form | HTML |
| POST | `/products/:id/update` | `inventory.updateProduct` | session + manager | Save product details and price changes | HTML redirect |
| POST | `/products/:id/archive` | `inventory.archiveProduct` | session + manager | Archive a product only after stock reaches zero | HTML redirect |
| GET | `/categories` | `inventory.categoriesPage` | session | List product categories | HTML |
| POST | `/categories` | `inventory.createCategory` | session + manager | Create a product category | HTML redirect |
| GET | `/categories/:id/edit` | `inventory.editCategoryPage` | session + manager | Edit a category | HTML |
| POST | `/categories/:id/update` | `inventory.updateCategory` | session + manager | Save a category | HTML redirect |
| POST | `/categories/:id/delete` | `inventory.deleteCategory` | session + manager | Delete a category if it has no products | HTML redirect |
| GET | `/suppliers` | `inventory.suppliersPage` | session | List suppliers | HTML |
| POST | `/suppliers` | `inventory.createSupplier` | session + manager | Add a supplier | HTML redirect |
| GET | `/suppliers/:id/edit` | `inventory.editSupplierPage` | session + manager | Edit supplier form | HTML |
| POST | `/suppliers/:id/update` | `inventory.updateSupplier` | session + manager | Save supplier changes | HTML redirect |
| POST | `/suppliers/:id/toggle` | `inventory.archiveSupplier` | session + manager | Activate or deactivate supplier | HTML redirect |
| GET | `/inventory` | `inventory.inventoryPage` | session | List current stock and reservation totals | HTML |
| GET | `/inventory/:type` | `inventory.movementFormPage` | session | Show stock-in, stock-out, or adjustment form | HTML |
| POST | `/inventory/movements/:type` | `inventory.createMovement` | session | Record a stock movement | HTML redirect |
| GET | `/movements` | `inventory.movementsPage` | session | Show stock movement history with filters | HTML |
| GET | `/movements/:id` | `inventory.movementDetailsPage` | session | Show one movement record | HTML |
| GET | `/alerts` | `inventory.alertsPage` | session | Show low-stock alert list | HTML |
| GET | `/notifications` | `inventory.notificationsPage` | session | Show notifications | HTML |
| POST | `/notifications/read-all` | `inventory.markAllNotificationsRead` | session | Mark all read | HTML redirect |
| POST | `/notifications/:id/read` | `inventory.markNotificationRead` | session | Mark one notification as read | HTML redirect |
| GET | `/reports` | `purchasing.reportsPage` | session + supervisor or manager | Show stock and purchase reports | HTML |
| GET | `/purchase-orders` | `purchasing.purchaseOrdersPage` | session | List purchase orders | HTML |
| POST | `/purchase-orders` | `purchasing.createPurchaseOrder` | session | Create a purchase order | HTML redirect |
| GET | `/purchase-orders/:id` | `purchasing.purchaseOrderDetailsPage` | session | Show order details and status changes | HTML |
| POST | `/purchase-orders/:id/items` | `purchasing.addPurchaseOrderItem` | session | Add a product line to a pending purchase order | HTML redirect |
| POST | `/purchase-orders/:id/status` | `purchasing.updatePurchaseOrderStatus` | session + manager | Change an order status | HTML redirect |
| GET | `/purchase-orders/:id/receive` | `purchasing.receiveDeliveryPage` | session | Show receive-delivery form | HTML |
| POST | `/purchase-orders/:id/receive` | `purchasing.receivePurchaseOrderItem` | session | Receive stock into inventory and update order status | HTML redirect |

## 3. Integration endpoints compared with `docs/integration-contract.md`

The repo does not contain a file named `docs/integration-contract.md`. The comparison below uses the contract draft described in the attached text and the actual endpoints implemented here.

| Contract item | Exists in my code? | My actual path or name if different | Notes |
|---|---|---|---|
| `GET /api/integration/v1/products` | Yes | same | Returns active products with `search`, `limit`, `offset` |
| `GET /api/integration/v1/products/{id}` | Yes | same | Returns one product |
| `GET /api/integration/v1/products/{id}/availability` | Yes | same | Uses `Inventory` and active `StockReservation` totals |
| `GET /api/integration/v1/products/{id}/price` | Yes | same | Returns `price` as a string |
| `POST /api/integration/v1/events` | Yes | same | Receives CRM events |
| `order.confirmed` | Yes | same | Creates active reservations and checks available stock |
| `sale.completed` | Yes | same | Consumes reservations and records a `stock_out` movement |
| `order.cancelled` | Yes | same | Releases active reservations |
| `sale.refunded` | Yes | same | Creates an Accounting refund event without restoring stock |
| `return.received` | Yes | same | Records stock-in movement and emits `InventoryReturnReceived` |
| `GET /crm/outbox` | Partly | `GET /api/integration/v1/:target/outbox` | Same concept, but one generic route instead of two static paths |
| `GET /accounting/outbox` | Partly | `GET /api/integration/v1/:target/outbox` | Same concept with `target` set to `accounting` |
| `POST /crm/outbox/{eventId}/ack` | Partly | `POST /api/integration/v1/:target/outbox/:eventId/ack` | Same concept and idempotent logic |
| `POST /accounting/outbox/{eventId}/ack` | Partly | `POST /api/integration/v1/:target/outbox/:eventId/ack` | Same concept and idempotent logic |
| Contract file exists in repo | No | Not found | `docs/api.md` exists; `docs/integration-contract.md` does not |

## 4. Security for calls between apps

- HMAC signing: Neither sending nor receiving. The integration middleware checks only `Authorization: Bearer <per-system token>` (CRM or Accounting, each limited to its own routes). The code does not inspect `X-JVZ-Client`, `X-JVZ-Timestamp`, or `X-JVZ-Signature` headers.
- Duplicate event protection: Yes. `IntegrationInbox` stores unique `eventId` rows and a unique `(source, eventType, transactionReference)` business reference. `findDuplicateEvent` in `services/integrationService.js` rejects duplicate or conflicting events and returns the original result for identical replays.
- Other auth used for API calls: For HTTP integrations, bearer-token auth only. For the browser app, session cookies are used and CSRF checks are enforced on non-GET HTML POST requests. No JWT-only API auth is implemented here.

## 5. Events and calls to OTHER apps

### 5.1 Events or HTTP calls this app SENDS to another app

I did not find any direct outbound HTTP client (`fetch`, `axios`, or other external call) in the code. Instead, the app writes durable outbound events to the `IntegrationOutbox` table. Those events are meant to be fetched by the other app by polling the integration endpoints.

Target app: CRM and Accounting

- Method: Polling of outbox records, not direct push
- URL pattern in code: `GET /api/integration/v1/:target/outbox`
- Acknowledgment pattern: `POST /api/integration/v1/:target/outbox/:eventId/ack`
- Event names actually emitted by the app:
  - CRM: `ProductCreated`, `ProductUpdated`, `ProductPriceUpdated`, `ProductUnavailable`, `LowStockDetected`, `StockReserved`, `StockReleased`, `StockDeducted`, `StockAdjusted`
  - Accounting: `PurchaseOrderCreated`, `PurchaseOrderUpdated`, `PurchaseOrderApproved`, `PurchaseOrderCancelled`, `GoodsReceiptRecorded`, `InventoryReturnReceived`, `RefundReported`
- Typical payload fields: product id / SKU / name / price / quantity / previous stock / current stock / reserved stock / available stock / order number / supplier id / supplier name / invoice reference / transaction reference.

### 5.2 Events or HTTP calls this app RECEIVES from another app

Source app: CRM

- Method: `POST`
- URL: `/api/integration/v1/events`
- Auth: bearer token
- Required fields: `eventId`, `eventType`
- Supported event types:
  - `order.confirmed` with `orderReference` and `items[]` containing `productId` and `quantity`
  - `sale.completed` with `orderReference` and `transactionReference`
  - `order.cancelled` with `orderReference`
  - `sale.refunded` with `orderReference` and `transactionReference`
  - `return.received` with `transactionReference` and `items[]`

### 5.3 Any connection to an app other than CRM

Yes: Accounting is connected via durable outbound events for purchase orders, goods receipts, refunds, and inventory returns. There is no HR integration found in this codebase.

### 5.4 Direct database access to other teams

Not found. The app does not connect directly to another team’s database. The code uses only its own MySQL database and HTTP/Bearer-token integration patterns.

## 6. Configuration

### 6.1 Environment variables used by the app

The app uses these environment variables (names and purpose only; no secrets copied here):

- `PORT` — HTTP port for the app; defaults to `3000`
- `DB_HOST` — MySQL host
- `DB_PORT` — MySQL port; default `3306`
- `DB_NAME` — Inventory database name
- `DB_USER` — MySQL user for the app
- `DB_PASSWORD` — MySQL password for the app
- `SESSION_SECRET` — Secret for Express session cookies
- Integration tokens — one per system (CRM, Accounting), stored hashed in `IntegrationTokens`, managed with `npm run token`. `INVENTORY_INTEGRATION_TOKEN` is no longer used
- `DB_LOGGING` — Optional SQL logging flag; `true` turns on verbose Sequelize logging

### 6.2 Base URLs for other apps

Not found. There are no stored configuration values such as `CRM_BASE_URL`, `ACCOUNTING_BASE_URL`, or `HR_BASE_URL` in the code. The app uses a durable outbox pattern and polling, rather than a fixed remote URL configuration in app code.

## 7. Team-specific questions (Inventory)

### Inventory: How are products, prices, and stock stored?

- Products are stored in the `Product` model (`name`, `sku`, `description`, `unitPrice`, `currentStock`, `minimumStock`, `unit`, `imagePath`, `isActive`).
- Prices are stored in `Product.unitPrice` as a DECIMAL(12,2).
- Physical stock is stored in the `Inventory` model (`quantity`), while the product model also keeps `currentStock` in sync.
- Each stock change writes a `StockMovement` row with `movementType`, `quantity`, `previousStock`, `updatedStock`, and remarks.

### Inventory: Is there any stock reservation?

Yes. The app includes a `StockReservation` model with `orderReference`, `quantity`, and `status`.

- Active reservations are subtracted from stock when available stock is calculated.
- `order.confirmed` events create reservations.
- `sale.completed` consumes reservations and decrements stock once.
- `order.cancelled` releases active reservations.

### Inventory: Who can change prices and stock?

- Product creation and price updates are manager-only via `requireManager` in the routes for product creation, editing, and updating.
- Stock movement actions (`stock_in`, `stock_out`, and `adjustment`) are available behind `requireAuth`, not `requireManager`. In practice, any logged-in user can create a stock movement. The system does not restrict these to manager-only access.

## 8. What is missing or blocking

- The contract file `docs/integration-contract.md` is not present in the codebase; the repository has `docs/api.md` and `docs/architecture.md` instead. A single agreed contract file is still needed.
- HMAC signing is not implemented for cross-app calls. The integration API only uses a bearer token.
- No live outbound HTTP client or remote base URL configuration was found; all app-to-app communication is outbox/polling oriented, not a direct push call.
- The app does not yet show live-mode or mock-mode configuration for CRM/Accounting integration, despite the contract draft discussing it.
- Before a real network test, the team still needs to agree on final URLs, token sharing, ACK behavior, and the real CRM/Accounting app configuration.
