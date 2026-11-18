import express from "express";
import { dashboardPage, homePage } from "../controllers/homeController.js";
import {
  loginPage, loginUser, logoutUser, profilePage, registerPage, registerUser,
  updateProfile, usersPage, toggleUser, editUserPage, updateUser, syncHrNow
} from "../controllers/authController.js";
import * as inventory from "../controllers/inventoryController.js";
import * as purchasing from "../controllers/purchaseController.js";
import { requireManager, requireSupervisorOrManager, requireAuth } from "../middleware/auth.js";
import { requireCrmToken, requireOutboxToken } from "../middleware/integrationAuth.js";
import * as integration from "../controllers/integrationController.js";
import { requireMovementPermission } from "../services/permissions.js";

const router = express.Router();
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// CRM token: products, events, crm/outbox. Accounting token: accounting/outbox only.
router.get("/api/integration/v1/products", requireCrmToken, asyncRoute(integration.products));
router.get("/api/integration/v1/products/:id", requireCrmToken, asyncRoute(integration.product));
router.get("/api/integration/v1/products/:id/availability", requireCrmToken, asyncRoute(integration.availability));
router.get("/api/integration/v1/products/:id/price", requireCrmToken, asyncRoute(integration.price));
router.post("/api/integration/v1/events", requireCrmToken, asyncRoute(integration.receiveEvent));
router.get("/api/integration/v1/:target/outbox", requireOutboxToken, asyncRoute(integration.outbox));
router.post("/api/integration/v1/:target/outbox/:eventId/ack", requireOutboxToken, asyncRoute(integration.acknowledgeEvent));

router.get("/", homePage);
router.get("/login", loginPage);
router.post("/login", asyncRoute(loginUser));
router.get("/register", asyncRoute(registerPage));
router.post("/register", asyncRoute(registerUser));
router.post("/logout", logoutUser);
router.get("/dashboard", requireAuth, asyncRoute(dashboardPage));

router.get("/profile", requireAuth, profilePage);
router.post("/profile", requireAuth, asyncRoute(updateProfile));
router.get("/users", requireManager, asyncRoute(usersPage));
router.post("/users/hr-sync", requireManager, asyncRoute(syncHrNow));
router.get("/users/:id/edit", requireManager, asyncRoute(editUserPage));
router.post("/users/:id/update", requireManager, asyncRoute(updateUser));
router.post("/users/:id/toggle", requireManager, asyncRoute(toggleUser));

router.get("/products", requireAuth, asyncRoute(inventory.productsPage));
router.post("/products", requireManager, asyncRoute(inventory.createProduct));
router.get("/products/:id", requireAuth, asyncRoute(inventory.productDetailsPage));
router.get("/products/:id/edit", requireManager, asyncRoute(inventory.editProductPage));
router.post("/products/:id/update", requireManager, asyncRoute(inventory.updateProduct));
router.post("/products/:id/archive", requireManager, asyncRoute(inventory.archiveProduct));

router.get("/categories", requireAuth, asyncRoute(inventory.categoriesPage));
router.post("/categories", requireManager, asyncRoute(inventory.createCategory));
router.get("/categories/:id/edit", requireManager, asyncRoute(inventory.editCategoryPage));
router.post("/categories/:id/update", requireManager, asyncRoute(inventory.updateCategory));
router.post("/categories/:id/delete", requireManager, asyncRoute(inventory.deleteCategory));
router.get("/suppliers", requireAuth, asyncRoute(inventory.suppliersPage));
router.post("/suppliers", requireManager, asyncRoute(inventory.createSupplier));
router.get("/suppliers/:id/edit", requireManager, asyncRoute(inventory.editSupplierPage));
router.post("/suppliers/:id/update", requireManager, asyncRoute(inventory.updateSupplier));
router.post("/suppliers/:id/toggle", requireManager, asyncRoute(inventory.archiveSupplier));

router.get("/inventory", requireAuth, asyncRoute(inventory.inventoryPage));
router.get("/inventory/:type", requireAuth, requireMovementPermission, asyncRoute(inventory.movementFormPage));
router.post("/inventory/movements/:type", requireAuth, requireMovementPermission, asyncRoute(inventory.createMovement));
router.get("/movements", requireAuth, asyncRoute(inventory.movementsPage));
router.get("/movements/:id", requireAuth, asyncRoute(inventory.movementDetailsPage));
router.get("/alerts", requireAuth, asyncRoute(inventory.alertsPage));
router.get("/notifications", requireAuth, asyncRoute(inventory.notificationsPage));
router.post("/notifications/read-all", requireAuth, asyncRoute(inventory.markAllNotificationsRead));
router.post("/notifications/:id/read", requireAuth, asyncRoute(inventory.markNotificationRead));
router.get("/reports", requireSupervisorOrManager, asyncRoute(purchasing.reportsPage));

router.get("/purchase-orders", requireAuth, asyncRoute(purchasing.purchaseOrdersPage));
router.post("/purchase-orders", requireAuth, asyncRoute(purchasing.createPurchaseOrder));
router.get("/purchase-orders/:id", requireAuth, asyncRoute(purchasing.purchaseOrderDetailsPage));
router.post("/purchase-orders/:id/items", requireAuth, asyncRoute(purchasing.addPurchaseOrderItem));
router.post("/purchase-orders/:id/status", requireManager, asyncRoute(purchasing.updatePurchaseOrderStatus));
router.get("/purchase-orders/:id/receive", requireAuth, asyncRoute(purchasing.receiveDeliveryPage));
router.post("/purchase-orders/:id/receive", requireAuth, asyncRoute(purchasing.receivePurchaseOrderItem));

export default router;
