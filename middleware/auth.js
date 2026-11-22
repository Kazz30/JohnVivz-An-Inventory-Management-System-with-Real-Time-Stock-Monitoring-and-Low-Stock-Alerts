import { User, Role, Notification, Product } from "../models/index.js";

// Header dropdown entry. Stock numbers and severity come from the notification's product as it is now.
const headerNotification = notification => {
  const product = notification.Product;
  const severity = !product ? ["Info", "info"]
    : product.currentStock <= 0 ? ["Critical", "critical"]
    : product.currentStock <= product.minimumStock ? ["Low stock", "warning"]
    : ["Restocked", "ok"];
  return {
    message: notification.message,
    date: notification.createdAt.toLocaleString(),
    href: product ? `/products/${product.id}` : "/notifications",
    productName: product?.name || "",
    hasStock: Boolean(product),
    currentStock: product?.currentStock,
    minimumStock: product?.minimumStock,
    severity: severity[0],
    severityKey: severity[1]
  };
};

export const loadCurrentUser = async (req, res, next) => {
  try {
    if (req.session.userId) {
      const user = await User.findByPk(req.session.userId, { include: Role });
      if (!user || !user.isActive) {
        req.session.destroy(() => {});
      } else {
        req.user = user;
        res.locals.currentUser = user;
        res.locals.unreadNotificationCount = await Notification.count({ where: { UserId: user.id, readAt: null } });
        const unread = await Notification.findAll({
          where: { UserId: user.id, readAt: null }, include: [{ model: Product, required: false }],
          order: [["createdAt", "DESC"]], limit: 6
        });
        res.locals.headerNotifications = unread.map(headerNotification);
      }
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAuth = (req, res, next) => {
  if (!req.user) return res.redirect("/login");
  next();
};

export const requireManager = (req, res, next) => {
  if (!req.user) return res.redirect("/login");
  if (req.user.Role?.name !== "manager") {
    req.flash("error_msg", "Inventory manager access is required for that action.");
    return res.redirect("/dashboard");
  }
  next();
};

export const requireSupervisorOrManager = (req, res, next) => {
  if (!req.user) return res.redirect("/login");
  if (!["manager", "supervisor"].includes(req.user.Role?.name)) {
    req.flash("error_msg", "Supervisor or manager access is required for that action.");
    return res.redirect("/dashboard");
  }
  next();
};

export const requireAdmin = requireManager;
