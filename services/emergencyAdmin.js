import { Op } from "sequelize";
import { Role, User } from "../models/index.js";

// The single local "break-glass" account that keeps a local password in live ESS mode:
// the manager named by EMERGENCY_ADMIN_EMAIL, or, if that is not set, the oldest local
// (not HR-linked) manager that has a password. Exactly one account, never an HR employee.
export const findEmergencyAdmin = async settings => {
  const where = { hrEmployeeId: null, password: { [Op.ne]: null } };
  if (settings.emergencyAdminEmail) where.email = settings.emergencyAdminEmail;
  return User.findOne({
    where,
    include: [{ model: Role, where: { name: "manager" } }],
    order: [["id", "ASC"]]
  });
};
