// Keeps Inventory user accounts in line with HR's employee master.
// - Creates a DEACTIVATED account (no local password) for each Inventory-department employee.
// - Updates name, email, position, HR status and (unless a manager overrode it) role.
// - Resigned / Terminated / Rejected, moved out of the department, or removed from HR:
//   deactivates the account at once and ends its sessions.
// Only identity, job title and status are stored; nothing about salary or personal details.
import { Op } from "sequelize";
import { Role, User, sequelize } from "../models/index.js";
import { getSettings, hrSyncConfigured } from "../config/settings.js";
import { HrApiError, createHrClient, normalizeEmployee } from "./hrClient.js";
import { parsePositionRoleMap, roleForPosition } from "./roleMapping.js";
import { endUserSessions } from "./sessionService.js";
import { findEmergencyAdmin } from "./emergencyAdmin.js";

export const TERMINAL_HR_STATUSES = ["Resigned", "Terminated", "Rejected"];
export const LEFT_DEPARTMENT_STATUS = "Left department";
export const NOT_IN_HR_STATUS = "Not found in HR";

const isTerminal = status => TERMINAL_HR_STATUSES.includes(status) ||
  status === LEFT_DEPARTMENT_STATUS || status === NOT_IN_HR_STATUS;
const sameCode = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

const deactivate = async (user, hrStatus, summary, now, sessionEnder, transaction = undefined) => {
  const wasActive = user.isActive;
  await user.update({ isActive: false, hrStatus, hrSyncedAt: now }, { transaction });
  const sessionsEnded = await sessionEnder(user.id, { transaction });
  if (wasActive || sessionsEnded) summary.deactivated.push({ employeeId: user.hrEmployeeId, status: hrStatus });
};

export const syncHrEmployees = async ({
  settings = getSettings(),
  client = createHrClient({ settings }),
  now = new Date(),
  sessionEnder = endUserSessions
} = {}) => {
  if (!hrSyncConfigured(settings)) {
    throw new HrApiError("HR sync is not configured. Set HR_API_URL, HR_API_TOKEN and INVENTORY_DEPARTMENT_CODE.");
  }
  const summary = { created: [], updated: 0, linked: [], deactivated: [], skipped: [], conflicts: [] };
  const { rules, errors } = parsePositionRoleMap(settings.positionRoleMap);
  if (errors.length) summary.conflicts.push({ reason: `Ignored invalid POSITION_ROLE_MAP entries: ${errors.join(", ")}` });

  const departments = await client.listDepartments();
  const department = departments.find(item => sameCode(item?.department_code, settings.inventoryDepartmentCode));
  if (!department) {
    throw new HrApiError(`HR has no department with code ${settings.inventoryDepartmentCode}.`);
  }
  const rawEmployees = await client.listEmployees({ departmentId: department.department_id });

  const roles = new Map((await Role.findAll()).map(role => [role.name, role]));
  const emergencyAdmin = await findEmergencyAdmin(settings);
  const seen = new Set();

  for (const raw of rawEmployees) {
    const employee = normalizeEmployee(raw);
    if (!employee) {
      summary.skipped.push({ reason: "missing employee ID or valid email" });
      continue;
    }
    // Defensive: never trust the server-side filter alone.
    if (!sameCode(employee.departmentCode, settings.inventoryDepartmentCode)) continue;
    seen.add(employee.employeeId);

    await sequelize.transaction(async transaction => {
      let user = await User.findOne({ where: { hrEmployeeId: employee.employeeId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!user) {
        const byEmail = await User.findOne({ where: { email: employee.email }, transaction, lock: transaction.LOCK.UPDATE });
        if (byEmail?.hrEmployeeId) {
          summary.conflicts.push({ employeeId: employee.employeeId, reason: "email belongs to another HR employee" });
          return;
        }
        if (byEmail && emergencyAdmin && byEmail.id === emergencyAdmin.id) {
          summary.conflicts.push({ employeeId: employee.employeeId, reason: "email belongs to the emergency admin account" });
          return;
        }
        if (byEmail) {
          // Adopt an account created by hand before HR sync existed.
          await byEmail.update({ hrEmployeeId: employee.employeeId }, { transaction });
          summary.linked.push(employee.employeeId);
          user = byEmail;
        }
      }

      if (TERMINAL_HR_STATUSES.includes(employee.status)) {
        if (!user) {
          summary.skipped.push({ employeeId: employee.employeeId, reason: `HR status ${employee.status}` });
          return;
        }
        await deactivate(user, employee.status, summary, now, sessionEnder, transaction);
        return;
      }

      const mappedRoleName = roleForPosition(employee.position, rules);
      if (!user) {
        const role = roles.get(mappedRoleName);
        await User.create({
          name: employee.fullName,
          email: employee.email,
          password: null,
          isActive: false,
          activatedAt: null,
          hrEmployeeId: employee.employeeId,
          position: employee.position,
          hrStatus: employee.status,
          roleOverridden: false,
          RoleId: role.id,
          role: role.name,
          hrSyncedAt: now
        }, { transaction });
        summary.created.push(employee.employeeId);
        return;
      }

      const updates = { name: employee.fullName, position: employee.position, hrStatus: employee.status, hrSyncedAt: now };
      if (employee.email !== user.email) {
        const taken = await User.findOne({ where: { email: employee.email, id: { [Op.ne]: user.id } }, transaction });
        if (taken) summary.conflicts.push({ employeeId: employee.employeeId, reason: "new HR email is already used by another account" });
        else updates.email = employee.email;
      }
      if (!user.roleOverridden) {
        const role = roles.get(mappedRoleName);
        updates.RoleId = role.id;
        updates.role = role.name;
      }
      if (isTerminal(user.hrStatus)) {
        // Rehired or back in the department: wait for a fresh ESS sign-in to activate again.
        updates.isActive = false;
        updates.activatedAt = null;
      }
      await user.update(updates, { transaction });
      summary.updated += 1;
    });
  }

  // HR-linked accounts that are no longer in the Inventory list: confirm one by one
  // before deactivating, so a short or failed list never locks everyone out.
  const missing = await User.findAll({
    where: { hrEmployeeId: { [Op.ne]: null, [Op.notIn]: [...seen].length ? [...seen] : [""] } }
  });
  for (const user of missing) {
    if (!user.isActive && isTerminal(user.hrStatus)) continue;
    let record;
    try {
      record = await client.getEmployee(user.hrEmployeeId);
    } catch (error) {
      summary.conflicts.push({ employeeId: user.hrEmployeeId, reason: `could not confirm with HR: ${error.message}` });
      continue;
    }
    const employee = record ? normalizeEmployee(record) : null;
    let status = null;
    if (!record) status = NOT_IN_HR_STATUS;
    else if (employee && TERMINAL_HR_STATUSES.includes(employee.status)) status = employee.status;
    else if (employee && !sameCode(employee.departmentCode, settings.inventoryDepartmentCode)) status = LEFT_DEPARTMENT_STATUS;
    if (status) await deactivate(user, status, summary, now, sessionEnder);
  }

  return summary;
};

// One sync at a time; the scheduler and the manager's "Sync now" button share it.
let running = null;
let lastRun = null;

export const getLastHrSync = () => lastRun;

export const runHrSync = async options => {
  if (running) return running;
  const startedAt = new Date();
  running = (async () => {
    try {
      const summary = await syncHrEmployees(options);
      lastRun = { ok: true, startedAt, finishedAt: new Date(), summary };
    } catch (error) {
      lastRun = { ok: false, startedAt, finishedAt: new Date(), error: error.message };
    }
    return lastRun;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
};

export const describeHrSync = run => {
  if (!run) return "HR sync has not run since the server started.";
  const when = run.finishedAt.toLocaleString();
  if (!run.ok) return `Last HR sync failed at ${when}: ${run.error}`;
  const s = run.summary;
  return `Last HR sync ${when}: ${s.created.length} created, ${s.updated} updated, ${s.linked.length} linked, ` +
    `${s.deactivated.length} deactivated, ${s.skipped.length} skipped, ${s.conflicts.length} need attention.`;
};

export const startHrSyncScheduler = ({ settings = getSettings(), log = console } = {}) => {
  if (!hrSyncConfigured(settings)) {
    log.warn("HR sync is off: set HR_API_URL, HR_API_TOKEN and INVENTORY_DEPARTMENT_CODE to enable it.");
    return () => {};
  }
  const tick = async () => {
    const run = await runHrSync();
    if (!run.ok) log.error(describeHrSync(run));
    else if (run.summary.conflicts.length) log.warn(describeHrSync(run), JSON.stringify(run.summary.conflicts));
  };
  tick();
  const timer = setInterval(tick, settings.hrSyncIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
};
