import { User, Role, Notification } from "../models/index.js";

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
