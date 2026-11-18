
import { Op, fn, col } from "sequelize";
import {
  Category, LowStockAlert, Notification, Product, PurchaseOrder, StockMovement, Supplier
} from "../models/index.js";

export const homePage = (req, res) => res.redirect(req.user ? "/dashboard" : "/login");

export const dashboardPage = async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [products, suppliers, lowStock, outOfStock, quantity, movements, notifications, activeAlerts, categoryRows, movementTotals, orders, todayMovementTotals, incomingDeliveries, inventoryRows] = await Promise.all([
    Product.count({ where: { isActive: true } }),
    Supplier.count({ where: { status: "active" } }),
    Product.count({ where: { isActive: true, currentStock: { [Op.gt]: 0, [Op.lte]: col("minimumStock") } } }),
    Product.count({ where: { isActive: true, currentStock: 0 } }),
    Product.sum("currentStock", { where: { isActive: true } }),
    StockMovement.findAll({ include: [Product, { association: "recordedBy" }], order: [["createdAt", "DESC"]], limit: 6 }),
    Notification.findAll({ where: { UserId: req.user.id, readAt: null }, include: [Product], order: [["createdAt", "DESC"]], limit: 5 }),
    LowStockAlert.count({ where: { status: "active" } }),
    Product.findAll({
      attributes: [[col("Category.name"), "categoryName"], [fn("SUM", col("currentStock")), "stock"]],
      include: [{ model: Category, attributes: [] }],
      where: { isActive: true },
      group: ["Category.id", "Category.name"],
      raw: true
    }),
    StockMovement.findAll({
      attributes: ["movementType", [fn("SUM", col("quantity")), "total"]],
      where: { createdAt: { [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      group: ["movementType"],
      raw: true
    }),
    PurchaseOrder.count({ where: { status: { [Op.in]: ["pending", "approved", "ordered", "partially_received"] } } }),
    StockMovement.findAll({
      attributes: ["movementType", [fn("SUM", col("quantity")), "total"]],
      where: { createdAt: { [Op.gte]: today } },
      group: ["movementType"],
      raw: true
    }),
    PurchaseOrder.count({ where: { status: { [Op.in]: ["ordered", "partially_received"] } } }),
    Product.findAll({ attributes: ["currentStock", "unitPrice"], where: { isActive: true } })
  ]);
  const role = req.user.Role?.name || "staff";
  const todayTotal = type => Number(todayMovementTotals.find(row => row.movementType === type)?.total || 0);
  const retailValue = inventoryRows.reduce((total, product) =>
    total + product.currentStock * Number(product.unitPrice), 0);
  const statsByRole = {
    manager: [
      { label: "Active products", value: products, tone: "blue" },
      { label: "Retail value at listed prices", value: retailValue.toLocaleString(undefined, { style: "currency", currency: "PHP" }), tone: "violet" },
      { label: "Low-stock products", value: lowStock, tone: "amber" },
      { label: "Out of stock", value: outOfStock, tone: "red" },
      { label: "Active suppliers", value: suppliers, tone: "green" },
      { label: "Open purchase orders", value: orders, tone: "blue" },
      { label: "Units on hand", value: quantity || 0, tone: "slate" },
      { label: "Stock movements today", value: todayTotal("stock_in") + todayTotal("stock_out") + todayTotal("adjustment"), tone: "amber" }
    ],
    supervisor: [
      { label: "Stock movements today", value: todayTotal("stock_in") + todayTotal("stock_out") + todayTotal("adjustment"), tone: "blue" },
      { label: "Incoming deliveries", value: incomingDeliveries, tone: "green" },
      { label: "Active low-stock alerts", value: activeAlerts, tone: "amber" },
      { label: "Open purchase orders", value: orders, tone: "violet" },
      { label: "Adjustments today", value: todayTotal("adjustment"), tone: "red" },
      { label: "Products to replenish", value: lowStock + outOfStock, tone: "slate" }
    ],
    staff: [
      { label: "Active products", value: products, tone: "blue" },
      { label: "Stock received today", value: todayTotal("stock_in"), tone: "green" },
      { label: "Stock issued today", value: todayTotal("stock_out"), tone: "amber" },
      { label: "Products to replenish", value: lowStock + outOfStock, tone: "red" },
      { label: "Incoming deliveries", value: incomingDeliveries, tone: "violet" },
      { label: "Recent stock activities", value: movements.length, tone: "slate" }
    ]
  };
  const dashboardTitles = {
    manager: "Inventory manager dashboard",
    supervisor: "Inventory supervisor dashboard",
    staff: "Inventory staff dashboard"
  };
  res.render("dashboard", {
    title: "Dashboard",
    dashboardHeading: dashboardTitles[role] || dashboardTitles.staff,
    dashboardSubtitle: role === "manager"
      ? "Inventory health, purchasing, product value, and system activity."
      : role === "supervisor"
        ? "Daily stock operations, incoming deliveries, and replenishment alerts."
        : "Your recent stock activity and the products that need attention.",
    dashboardActionHref: role === "staff" ? "" : "/purchase-orders",
    dashboardActionLabel: role === "staff" ? "" : "Review purchase orders",
    stats: statsByRole[role] || statsByRole.staff,
    movements: movements.map(item => ({
      product: item.Product.name,
      type: item.movementType.replace("_", " "),
      quantity: item.quantity,
      date: item.createdAt.toLocaleString(),
      user: item.recordedBy?.name || "CRM integration"
    })),
    notifications: notifications.map(item => ({ message: item.message, date: item.createdAt.toLocaleString() })),
    categoryChart: JSON.stringify({
      labels: categoryRows.map(row => row.categoryName || "Uncategorized"),
      values: categoryRows.map(row => Number(row.stock || 0))
    }),
    movementChart: JSON.stringify({
      labels: ["Stock in", "Stock out", "Adjustments"],
      values: ["stock_in", "stock_out", "adjustment"].map(type => Number(movementTotals.find(row => row.movementType === type)?.total || 0))
    })
  });
};
