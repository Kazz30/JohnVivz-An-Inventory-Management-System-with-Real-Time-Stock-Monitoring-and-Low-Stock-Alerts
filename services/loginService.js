// Decides every sign-in attempt, rate-limits it and writes one LoginAttempt audit row.
// ESS_LOGIN_MODE=local: today's local password check.
// ESS_LOGIN_MODE=live : JVzPay department login for HR-synced employees; only the single
//                       emergency admin keeps a local password.
import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { Op } from "sequelize";
import { LoginAttempt, Role, User } from "../models/index.js";
import { getSettings } from "../config/settings.js";
import { callJvzpayLogin } from "./jvzpayClient.js";
import { findEmergencyAdmin } from "./emergencyAdmin.js";
import { TERMINAL_HR_STATUSES, LEFT_DEPARTMENT_STATUS, NOT_IN_HR_STATUS } from "./hrSyncService.js";

export const GENERIC_LOGIN_ERROR = "Email or password is incorrect.";
export const ESS_UNAVAILABLE_ERROR = "ESS is unavailable, try again later.";
export const RATE_LIMITED_ERROR = "Too many sign-in attempts. Try again in a few minutes.";

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 20;

// Compared against when there is no stored hash, so response time does not reveal
// whether the email exists.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await bcrypt.hash(randomBytes(16).toString("hex"), 12));
const BLOCKED_HR_STATUSES = [...TERMINAL_HR_STATUSES, LEFT_DEPARTMENT_STATUS, NOT_IN_HR_STATUS];
const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

const passwordMatches = async (password, hash) => {
  if (Buffer.byteLength(password, "utf8") > 72) {
    await bcrypt.compare("x", await getDummyHash());
    return false;
  }
  const ok = await bcrypt.compare(password, hash || await getDummyHash());
  return ok && Boolean(hash);
};

const isRateLimited = async (email, ipAddress) => {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const [byEmail, byIp] = await Promise.all([
    LoginAttempt.count({ where: { email, outcome: "failure", createdAt: { [Op.gte]: since } } }),
    LoginAttempt.count({ where: { ipAddress, outcome: "failure", createdAt: { [Op.gte]: since } } })
  ]);
  return byEmail >= MAX_FAILURES_PER_EMAIL || byIp >= MAX_FAILURES_PER_IP;
};

const localCheck = async (email, password, user) => {
  const ok = await passwordMatches(password, user?.password);
  if (!user) return { ok: false, reason: "unknown_email" };
  if (!user.password) return { ok: false, reason: "no_local_password" };
  if (!ok) return { ok: false, reason: "wrong_password" };
  if (!user.isActive) return { ok: false, reason: "account_inactive" };
  return { ok: true, user, reason: "local_password" };
};

const essCheck = async ({ email, password, settings, fetchImpl }) => {
  const ess = await callJvzpayLogin({ email, password, settings, fetchImpl });
  if (ess.kind === "unavailable") return { ok: false, unavailable: true, reason: ess.reason };
  if (ess.kind === "rejected") return { ok: false, reason: ess.reason };

  const employee = ess.employee;
  if (!settings.inventoryDepartmentCode || !same(employee.department_code, settings.inventoryDepartmentCode)) {
    return { ok: false, reason: "not_inventory_department" };
  }
  if (!settings.essAllowedStatuses.some(status => same(status, employee.employment_status))) {
    return { ok: false, reason: "employment_not_active" };
  }
  if (!same(employee.email, email)) return { ok: false, reason: "ess_email_mismatch" };

  const user = await User.findOne({ where: { hrEmployeeId: String(employee.employee_id) }, include: Role });
  if (!user) return { ok: false, reason: "not_in_synced_list" };
  if (!same(user.email, email)) return { ok: false, reason: "synced_email_mismatch" };
  if (BLOCKED_HR_STATUSES.includes(user.hrStatus)) return { ok: false, reason: "hr_access_removed" };
  if (!user.isActive) {
    if (user.activatedAt) return { ok: false, reason: "account_disabled" };
    // First successful ESS sign-in activates the account (only if still pending).
    const [activated] = await User.update(
      { isActive: true, activatedAt: new Date() },
      { where: { id: user.id, isActive: false, activatedAt: null } }
    );
    if (!activated) return { ok: false, reason: "account_disabled" };
    await user.reload({ include: Role });
    return { ok: true, user, reason: "ess_first_activation" };
  }
  return { ok: true, user, reason: "ess" };
};

export const authenticate = async ({
  email: rawEmail, password: rawPassword, ipAddress = "unknown",
  settings = getSettings(), fetchImpl
}) => {
  const email = String(rawEmail || "").trim().toLowerCase().slice(0, 190);
  const password = String(rawPassword || "");
  const ip = String(ipAddress || "unknown").slice(0, 64);
  let mode = settings.essLoginMode;

  const audit = (outcome, reason, userId = null) =>
    LoginAttempt.create({ email, ipAddress: ip, mode, outcome, reason, userId });

  if (await isRateLimited(email, ip)) {
    await audit("rate_limited", "too_many_failures");
    return { ok: false, message: RATE_LIMITED_ERROR };
  }
  if (!email || !password) {
    await audit("failure", "missing_credentials");
    return { ok: false, message: GENERIC_LOGIN_ERROR };
  }

  let result;
  if (mode === "local") {
    result = await localCheck(email, password, await User.findOne({ where: { email }, include: Role }));
  } else {
    const emergencyAdmin = await findEmergencyAdmin(settings);
    if (emergencyAdmin && same(emergencyAdmin.email, email)) {
      mode = "emergency";
      result = await localCheck(email, password, emergencyAdmin);
    } else {
      result = await essCheck({ email, password, settings, fetchImpl });
    }
  }

  if (result.ok) {
    await audit("success", result.reason, result.user.id);
    return { ok: true, user: result.user };
  }
  if (result.unavailable) {
    await audit("ess_unavailable", result.reason);
    return { ok: false, message: ESS_UNAVAILABLE_ERROR };
  }
  await audit("failure", result.reason);
  return { ok: false, message: GENERIC_LOGIN_ERROR };
};
