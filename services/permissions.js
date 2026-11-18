// Who may record each manual stock movement. Supervisors are inventory staff too, so
// they may receive and issue stock; only managers may overwrite counts with adjustments.
export const MOVEMENT_ROLES = Object.freeze({
  stock_in: Object.freeze(["staff", "supervisor", "manager"]),
  stock_out: Object.freeze(["staff", "supervisor", "manager"]),
  adjustment: Object.freeze(["manager"])
});

export const MOVEMENT_TYPE_BY_SLUG = Object.freeze({
  "stock-in": "stock_in",
  "stock-out": "stock_out",
  adjustment: "adjustment"
});

export const canRecordMovement = (user, movementType) =>
  Boolean(user?.isActive && MOVEMENT_ROLES[movementType]?.includes(user.Role?.name));

// Route guard for /inventory/:type and /inventory/movements/:type.
export const requireMovementPermission = (req, res, next) => {
  if (!req.user) return res.redirect("/login");
  const movementType = MOVEMENT_TYPE_BY_SLUG[req.params.type];
  if (!movementType) return next();
  if (!canRecordMovement(req.user, movementType)) {
    req.flash("error_msg", movementType === "adjustment"
      ? "Only inventory managers can adjust stock counts."
      : "Your role is not allowed to record stock movements.");
    return res.redirect("/inventory");
  }
  next();
};
