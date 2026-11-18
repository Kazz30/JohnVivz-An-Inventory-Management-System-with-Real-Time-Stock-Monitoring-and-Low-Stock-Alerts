# Inventory integration API

Base path: `/api/integration/v1`

All routes require `Authorization: Bearer <token>` and HTTPS in deployed environments. JSON responses use UTF-8. Product reads are served from the Inventory database, the authoritative source for official price and stock.

### Tokens

Each calling system has its own token, and a token only works on its own system's routes:

| Token | Allowed routes |
|---|---|
| CRM (`jvi_crm_…`) | `GET /products`, `/products/{id}`, `/products/{id}/availability`, `/products/{id}/price`, `POST /events`, `GET /crm/outbox`, `POST /crm/outbox/{eventId}/ack` |
| Accounting (`jvi_accounting_…`) | `GET /accounting/outbox`, `POST /accounting/outbox/{eventId}/ack` |

- No token, an unknown token, or a revoked token: `401` `{ "error": "A valid integration bearer token is required." }`.
- A valid token on another system's route (for example a CRM token on `/accounting/outbox`): `403` `{ "error": "This integration token is not allowed to use this route." }`.

The Inventory team creates and revokes tokens with `npm run token -- create crm|accounting "<name>"`, `npm run token -- list`, and `npm run token -- revoke <id>`. A token is shown once when created; Inventory stores only its SHA-256 hash. Revocation takes effect on the next request. Tokens are given privately to each system's developers. Do not send them by email or chat in plain text.

## Product reads (CRM)

| Method | Path | Purpose |
|---|---|---|
| GET | `/products?search=&limit=100&offset=0` | List active products |
| GET | `/products/{id}` | Read a product |
| GET | `/products/{id}/availability` | Read on-hand, reserved, and available stock |
| GET | `/products/{id}/price` | Read the official selling price |

Product list responses are `{ "data": [...], "pagination": { "limit": 100, "offset": 0 } }`. `limit` is capped at 200. Product records include `id`, `sku`, `barcode` (currently the SKU), `name`, `description`, `category`, `unit`, `price` (a decimal string), `imagePath`, `supplier`, `physicalStock`, `reservedStock`, `availableStock`, `minimumStock`, and `status`.

## CRM events received by Inventory

`POST /events` receives one event per request. Every event needs a unique `eventId` and a supported `eventType` (`order.confirmed`, `sale.completed`, `order.cancelled`, `sale.refunded`, `return.received`; these names are unchanged). Inventory records each successful event and applies its stock changes and outbound events in one database transaction.

### Responses

| Status | Body | Meaning |
|---|---|---|
| `202` | `{ "eventId", "duplicate": false, "result": {...} }` | Processed now |
| `200` | `{ "eventId", "duplicate": true, "result": {...} }` | Already processed earlier. `result` is the original result; nothing was applied again |
| `400` | `{ "error" }` | Invalid body (missing fields, bad quantities, unsupported fields or event type) |
| `401` | `{ "error" }` | Missing, unknown or revoked bearer token |
| `403` | `{ "error" }` | Token belongs to another system (Accounting token on a CRM route) |
| `409` | `{ "error", "code", "details"? }` | Business conflict; nothing was changed (see codes below) |

`409` codes: `insufficient_stock`, `product_unavailable` (unknown or archived product), `reservation_conflict` (the order already holds a different reservation for that product), and `conflict` (any other business conflict, such as reusing an `eventId` or reference with different data).

Rejected events (`400`/`409`) are not recorded, so the same `eventId` can be sent again later.

### Reserve stock: `order.confirmed`

```json
{
  "eventId": "crm-evt-0001",
  "eventType": "order.confirmed",
  "orderReference": "CRM-ORDER-105",
  "items": [{ "productId": 12, "quantity": 2 }, { "productId": 14, "quantity": 3 }]
}
```

Success (`202`):

```json
{
  "eventId": "crm-evt-0001",
  "duplicate": false,
  "result": {
    "orderReference": "CRM-ORDER-105",
    "reservations": [
      { "productId": 12, "quantity": 2, "status": "reserved" },
      { "productId": 14, "quantity": 3, "status": "reserved" }
    ]
  }
}
```

Reservations reduce available stock, not physical stock.

#### When stock is not enough

Inventory checks every line before reserving anything. If any line exceeds available stock (physical minus active reservations), the whole order is rejected and **no reservation is created for any line**, including lines that would have fit. No `StockReserved` events are queued either.

Response: **`409 Conflict`**

```json
{
  "error": "Insufficient available stock for Blue Pen.",
  "code": "insufficient_stock",
  "details": {
    "orderReference": "CRM-ORDER-105",
    "reserved": false,
    "shortages": [
      { "productId": 14, "sku": "PEN-BLU", "requestedQuantity": 3, "availableStock": 1 }
    ]
  }
}
```

- `shortages` lists every short line, not just the first. With several short lines, `error` reads `Insufficient available stock for N products.`
- `availableStock` is never negative.
- The event is not recorded. CRM may send the same `eventId` again after restocking or after changing the order. A changed order must use a new `eventId`.

#### Repeating the same `orderReference`

An `orderReference` is reserved at most once:

| CRM sends | Inventory answers | Stock effect |
|---|---|---|
| The same `eventId` again | `200`, `duplicate: true`, original `result` | None |
| A new `eventId`, same `orderReference`, same `items` | `200`, `duplicate: true`, original `result` (the response's `eventId` is the new one) | None |
| A new `eventId`, same `orderReference`, different `items` | `409`, `code: "conflict"` | None |
| The same `eventId` with a different body | `409`, `code: "conflict"` | None |
| Several of the above at the same moment | Exactly one `202`; the others `200` duplicate | Reserved once |

This rests on a unique database index on (`orderReference`, product) for reservations and on (`source`, `eventType`, `transactionReference`) for processed events, so it also holds under concurrent requests. After `order.cancelled`, the same `orderReference` is not reserved again: resending the original confirmation returns `200` duplicate with the original result and reserves nothing. Use a new order reference for a new order.

### Deduct stock: `sale.completed`

```json
{
  "eventId": "crm-evt-0002",
  "eventType": "sale.completed",
  "orderReference": "CRM-ORDER-105",
  "transactionReference": "CRM-SALE-811"
}
```

The sale consumes the active reservation and records one stock-out movement per reserved product. Sales without an active reservation are rejected (`409`). A duplicate transaction reference cannot deduct the same product twice.

### Other supported events

- `order.cancelled`: requires `orderReference`; releases active reservations. Fails with `409` if the order was already fulfilled.
- `sale.refunded`: requires `orderReference` and `transactionReference`; queues `RefundReported` for Accounting but does not restore stock.
- `return.received`: requires `transactionReference` and `items`; records stock-in movements for physically received goods and queues `InventoryReturnReceived` for Accounting.

A refund alone is not proof that goods were returned. Send `return.received` only when returned inventory has been physically received.

## Durable outbound events

Inventory stores outbound events in `IntegrationOutbox` in the same transaction as the product, movement, reservation, or purchasing change they describe. Consumers poll:

- `GET /crm/outbox?limit=100`
- `GET /accounting/outbox?limit=100` (polled by JVzPay)

`limit` defaults to 100 and is capped at 500. Only unacknowledged events are returned, oldest first.

After durably processing an event, acknowledge it. Acknowledgment is idempotent (acknowledging twice returns `200` both times). An unknown `eventId` returns `404`.

- `POST /crm/outbox/{eventId}/ack`
- `POST /accounting/outbox/{eventId}/ack`

Polling is at-least-once: an unacknowledged event stays available for retry. Consumers must deduplicate by `eventId` and acknowledge only after their own transaction commits.

### Envelope

```json
{
  "data": [
    {
      "eventId": "6f1c2a9e-1d7b-4a43-9a0e-0d2b7c1f5e11",
      "eventType": "GoodsReceiptRecorded",
      "transactionReference": "PO-1763280000000-3FA2:18:10",
      "occurredAt": "2026-11-16T08:15:02.000Z",
      "data": { "...": "event payload, below" }
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `eventId` | string (UUID v4) | Unique per event. Use it for deduplication |
| `eventType` | string | One of the names below |
| `transactionReference` | string or null | Business reference (see each event). **Not unique**; do not deduplicate on it |
| `occurredAt` | ISO-8601 UTC string | When Inventory committed the change |
| `data` | object | Event payload |

CRM outbox event names: `ProductCreated`, `ProductUpdated`, `ProductPriceUpdated`, `StockReceived`, `StockReserved`, `StockReleased`, `StockDeducted`, `StockAdjusted`, `LowStockDetected`, `ProductUnavailable`.

## Accounting events (`/accounting/outbox`)

Common conventions:

- `orderNumber` is Inventory's purchase-order number (`PO-<ms timestamp>-<4 hex>`), unique per order.
- `supplierId` is Inventory's supplier ID (integer); `supplierName` is the supplier's name when the event was created.
- `productId` is Inventory's product ID (integer); `sku` is its SKU.
- **Money is always a decimal string with two places** (`"12.50"`, `"3.00"`), never a JSON number, in every event: `unitPrice`, `unitCost`, `receivedCost` here, and `price`, `previousPrice`, `newPrice` in the CRM product events. Parse them as decimals, not floats.
- Currency is PHP. No tax, discount, or payment terms are sent; Inventory does not hold them.

### `PurchaseOrderCreated`

Sent when a purchase order is created (status `pending`). An order starts with one line; more lines come as `PurchaseOrderUpdated`.

`transactionReference`: `orderNumber`

| Field | Type | Notes |
|---|---|---|
| `orderNumber` | string | |
| `supplierId` | integer | |
| `supplierName` | string | |
| `items` | array (1 entry) | `{ productId: integer, sku: string, quantity: integer ≥ 1, unitPrice: money string }` |

### `PurchaseOrderUpdated`

Sent once for each line added to a `pending` order.

`transactionReference`: `orderNumber`

| Field | Type | Notes |
|---|---|---|
| `orderNumber` | string | |
| `supplierId` | integer | |
| `supplierName` | string | |
| `addedItem` | object | `{ productId: integer, sku: string, quantity: integer ≥ 1, unitPrice: money string }`. Only the new line, not the whole order |

### `PurchaseOrderApproved`

Sent when a manager approves a `pending` order. Carries the full line list, so Accounting can rebuild the order from it.

`transactionReference`: `orderNumber`

| Field | Type | Notes |
|---|---|---|
| `orderNumber` | string | |
| `supplierId` | integer | |
| `supplierName` | string | |
| `status` | string | Always `"approved"` |
| `items` | array | Each `{ productId: integer, quantity: integer, receivedQuantity: integer, unitPrice: money string }`. **No `sku`** in this event |

### `PurchaseOrderCancelled`

Sent when a manager cancels an order that is `pending`, `approved`, or `ordered`. An order with any received quantity cannot be cancelled.

`transactionReference`: `orderNumber`

Same fields as `PurchaseOrderApproved`, with `status` always `"cancelled"`. `receivedQuantity` is always 0.

The change from `approved` to `ordered` (sent to supplier) produces no Accounting event.

### `GoodsReceiptRecorded`

Sent for each delivery received against one purchase-order line, in the same transaction as the stock-in.

`transactionReference`: `<orderNumber>:<purchase-order line ID>:<cumulative quantity received on that line after this delivery>`, e.g. `PO-1763280000000-3FA2:18:10`.

| Field | Type | Notes |
|---|---|---|
| `orderNumber` | string | |
| `supplierId` | integer | |
| `supplierName` | string | |
| `invoiceReference` | string or null | Supplier invoice reference entered at receipt, else the last one stored on the order, else `null`. Max 120 characters |
| `productId` | integer | |
| `sku` | string | |
| `receivedQuantity` | integer ≥ 1 | Quantity in **this** delivery (not cumulative) |
| `unitCost` | decimal string | Purchase-order unit price for the line |
| `receivedCost` | decimal string | `unitCost × receivedQuantity`, exact to two decimals |
| `receivedById` | integer | Inventory user ID of the person who received the goods |

The order status (`partially_received` / `received`) follows from the receipts; no separate event is sent.

### `InventoryReturnReceived`

Sent for each product line of a CRM `return.received` event, after the returned goods are restocked.

`transactionReference`: the CRM return's `transactionReference`. Every line of one return shares it.

| Field | Type | Notes |
|---|---|---|
| `productId` | integer | |
| `sku` | string | |
| `quantity` | integer ≥ 1 | Units returned to stock |

No price or customer data is included. Value the return from CRM's sale records.

### `RefundReported`

Sent when CRM reports a refund (`sale.refunded`). It does not change stock.

`transactionReference`: the CRM refund's `transactionReference`.

| Field | Type | Notes |
|---|---|---|
| `orderReference` | string | CRM order reference |
| `transactionReference` | string | CRM refund transaction reference |

No amount is included; Inventory does not know refund amounts.

## Errors

Responses have `{ "error": "..." }`; business conflicts also carry `code` and, where useful, `details`. `400` means invalid input, `401` a missing, unknown or revoked bearer token, `403` a token from another system, `404` a missing product or pending event, and `409` an inventory or business conflict (including insufficient available stock).

## Scope and ownership

Inventory owns product and stock data; it does not create CRM orders or Accounting ledgers or payables. Purchase-order and goods-receipt events are queued for Accounting. CRM order confirmations reserve stock, sale completions deduct it, cancellations release it, and physical returns add stock only after receipt.

## Inventory as a client (HR and JVzPay)

Inventory also calls two other systems. These are outgoing calls, not part of this API:

- **HR** (`HR_API_URL`, `HR_API_TOKEN`): every 5 minutes, and when a manager clicks **Sync now**, Inventory reads `GET /api/integration/v1/departments` and `GET /api/integration/v1/employees?department_id=…&page=…&page_size=100` (all pages), plus `GET /api/integration/v1/employees/{permanent_employee_id}` for accounts missing from the list. It keeps only `permanent_employee_id`, `full_name`, `email`, `position`, `status` and the department code. It does not store `employee_code` (the Employee Unique Code ESS registration relies on), salary, or any other personal data.
- **JVzPay** (`JVZPAY_API_URL`, `JVZPAY_API_TOKEN`): when `ESS_LOGIN_MODE=live`, each sign-in posts `{ email, password }` to `POST /api/integration/v1/auth/login`. Inventory never stores the password.
