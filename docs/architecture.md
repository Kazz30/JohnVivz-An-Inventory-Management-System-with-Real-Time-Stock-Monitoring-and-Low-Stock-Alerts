# Inventory architecture

The application uses the existing XianFire conventions: Express routes and middleware, Sequelize models backed by MySQL, and Handlebars-compatible `.xian` views.

## Deployment / integration context

```mermaid
flowchart LR
  Browser[Inventory users] -->|HTTPS| App[Express / XianFire application]
  CRM[CRM] -->|Bearer token: product reads and order / sale / return events| App
  App -->|Durable CRM outbox events| CRM
  App -->|Durable purchase / receipt / return events| Accounting[Accounting]
  Accounting -->|Acknowledge delivered events| App
  App -->|Sequelize transactions| DB[(Inventory MySQL database)]
  HR[HR employee directory] -. authorized employee references are not yet integrated .-> App
```

CRM and Accounting remain separate systems. Inventory does not own customer orders, payable balances, or general-ledger entries.

## Entity relationship diagram

```mermaid
erDiagram
  ROLE ||--o{ USER : assigns
  CATEGORY ||--o{ PRODUCT : categorizes
  SUPPLIER ||--o{ PRODUCT : supplies
  SUPPLIER ||--o{ PURCHASE_ORDER : receives
  USER ||--o{ PURCHASE_ORDER : creates
  PURCHASE_ORDER ||--|{ PURCHASE_ORDER_ITEM : contains
  PRODUCT ||--o{ PURCHASE_ORDER_ITEM : ordered
  PRODUCT ||--|| INVENTORY : balances
  PRODUCT ||--o{ STOCK_MOVEMENT : records
  USER o|--o{ STOCK_MOVEMENT : records
  PRODUCT ||--o{ STOCK_RESERVATION : reserves
  PRODUCT ||--o{ LOW_STOCK_ALERT : alerts
  USER ||--o{ NOTIFICATION : receives
  PRODUCT o|--o{ NOTIFICATION : concerns
  INTEGRATION_INBOX {
    string eventId UK
    string source
    string eventType
    string transactionReference
    text payload
  }
  INTEGRATION_OUTBOX {
    uuid eventId UK
    string target
    string eventType
    string transactionReference
    text payload
    datetime publishedAt
  }
  STOCK_RESERVATION {
    string orderReference
    int ProductId
    int quantity
    string status
  }
  STOCK_MOVEMENT {
    int ProductId
    int recordedById
    string externalReference UK
    string source
    int quantity
    int previousStock
    int updatedStock
  }
```

`Inventory.quantity` is the physical on-hand balance. Active `StockReservation` quantities are subtracted to compute available stock. Every physical quantity change updates the inventory and product balance and inserts an immutable stock movement within one transaction. External movements carry unique references to prevent replayed deductions.

## Core class / model relationships

```mermaid
classDiagram
  class Product {
    +id
    +sku
    +name
    +unitPrice
    +currentStock
    +minimumStock
  }
  class Inventory {
    +ProductId
    +quantity
    +location
  }
  class StockMovement {
    +movementType
    +quantity
    +previousStock
    +updatedStock
    +externalReference
    +source
  }
  class StockReservation {
    +orderReference
    +quantity
    +status
  }
  class IntegrationInbox {
    +eventId
    +source
    +eventType
    +status
  }
  class IntegrationOutbox {
    +eventId
    +target
    +eventType
    +publishedAt
  }
  class PurchaseOrder
  class PurchaseOrderItem
  class Supplier
  class User
  Product "1" --> "1" Inventory
  Product "1" --> "*" StockMovement
  Product "1" --> "*" StockReservation
  Product "1" --> "*" PurchaseOrderItem
  Supplier "1" --> "*" PurchaseOrder
  PurchaseOrder "1" --> "*" PurchaseOrderItem
  User "1" --> "*" PurchaseOrder
  User "0..1" --> "*" StockMovement
```
