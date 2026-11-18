import bcrypt from "bcrypt";
import { User, Role } from "../models/index.js";
import { makeFields, renderModule } from "./viewHelpers.js";
import { getSettings, hrSyncConfigured } from "../config/settings.js";
import { authenticate } from "../services/loginService.js";
import {
  describeHrSync, getLastHrSync, runHrSync, TERMINAL_HR_STATUSES, LEFT_DEPARTMENT_STATUS, NOT_IN_HR_STATUS
} from "../services/hrSyncService.js";
import { parsePositionRoleMap, roleForPosition } from "../services/roleMapping.js";
import { endUserSessions } from "../services/sessionService.js";

const validPassword = password => Buffer.byteLength(password, "utf8") >= 10 && Buffer.byteLength(password, "utf8") <= 72;
const BLOCKED_HR_STATUSES = [...TERMINAL_HR_STATUSES, LEFT_DEPARTMENT_STATUS, NOT_IN_HR_STATUS];
const accountStatus = user => user.isActive ? "Active" : user.activatedAt ? "Inactive" : "Pending first ESS sign-in";

export const loginPage = (req, res) => {
  if (req.user) return res.redirect("/dashboard");
  res.render("login", { title: "Sign in", essLive: getSettings().essLoginMode === "live" });
};

export const loginUser = async (req, res) => {
  const result = await authenticate({ email: req.body.email, password: req.body.password, ipAddress: req.ip });
  if (!result.ok) {
    req.flash("error_msg", result.message);
    return res.redirect("/login");
  }
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.userId = result.user.id;
  await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
  res.redirect("/dashboard");
};

// First-run setup creates the local manager (the emergency admin). HR-synced accounts
// do not count, so an early HR sync cannot block setup.
const localAccountCount = () => User.count({ where: { hrEmployeeId: null } });

export const registerPage = async (req, res) => {
  if (await localAccountCount()) return res.redirect(req.user?.Role?.name === "manager" ? "/users" : "/login");
  res.render("register", { title: "Create inventory manager account", setupMode: true });
};

export const registerUser = async (req, res) => {
  if (await localAccountCount()) {
    req.flash("error_msg", "Initial setup is already complete.");
    return res.redirect("/login");
  }
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !validPassword(password)) {
    req.flash("error_msg", "Enter a name, valid email, and password between 10 and 72 UTF-8 bytes.");
    return res.redirect("/register");
  }
  const [role] = await Role.findOrCreate({ where: { name: "manager" } });
  const existing = await User.findOne({ where: { email } });
  if (existing) throw new Error("That email address is already registered.");
  const user = await User.create({
    name, email, password: await bcrypt.hash(password, 12), RoleId: role.id, role: role.name, activatedAt: new Date()
  });
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.userId = user.id;
  res.redirect("/dashboard");
};

export const logoutUser = (req, res) => {
  req.session.destroy(error => {
    if (error) return res.status(500).send("Unable to end the session.");
    res.clearCookie("johnvivz.sid");
    res.redirect("/login");
  });
};

export const profilePage = (req, res) => {
  if (req.user.hrEmployeeId) {
    return renderModule(res, {
      title: "My profile",
      subtitle: "Your name and email come from HR. Change your password in ESS (JVzPay).",
      section: "profile",
      showForm: false,
      showTable: false,
      details: [
        { label: "Full name", value: req.user.name },
        { label: "Email address", value: req.user.email },
        { label: "Employee ID", value: req.user.hrEmployeeId },
        { label: "Position", value: req.user.position || "—" }
      ]
    });
  }
  renderModule(res, {
    title: "My profile",
    subtitle: "Manage your account details.",
    section: "profile",
    showForm: true,
    showTable: false,
    formTitle: "Update profile",
    formAction: "/profile",
    showActions: false,
    fields: makeFields([
      ["name", "Full name", "text", true],
      ["email", "Email address", "email", true],
      ["password", "New password (leave blank to keep current)", "password"]
    ], { ...req.user.toJSON(), password: "" })
  });
};

export const updateProfile = async (req, res) => {
  if (req.user.hrEmployeeId) throw new Error("Your profile is managed by HR and your password by ESS.");
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid name and email address.");
  const duplicate = await User.findOne({ where: { email } });
  if (duplicate && duplicate.id !== req.user.id) throw new Error("That email address is already in use.");
  const updates = { name, email };
  if (password) {
    if (!validPassword(password)) throw new Error("New passwords must be between 10 and 72 UTF-8 bytes.");
    updates.password = await bcrypt.hash(password, 12);
  }
  await req.user.update(updates);
  req.flash("success_msg", "Profile updated.");
  res.redirect("/profile");
};

export const usersPage = async (req, res) => {
  const settings = getSettings();
  const syncOn = hrSyncConfigured(settings);
  const users = await User.findAll({ include: Role, order: [["name", "ASC"]] });
  renderModule(res, {
    title: "User management",
    subtitle: "Employees are created by the HR sync and activated by their first ESS sign-in.",
    section: "users",
    columns: ["Name", "Email", "Role", "Status", "HR employee ID", "Position", "HR status", "Role source"],
    rows: users.map(user => ({
      id: user.id,
      href: `/users/${user.id}/edit`,
      cells: [
        user.name, user.email, user.Role.name, accountStatus(user), user.hrEmployeeId || "Local account",
        user.position || "—", user.hrStatus || "—",
        user.hrEmployeeId ? (user.roleOverridden ? "Manual override" : "HR position") : "Manual"
      ],
      toggleLabel: user.isActive ? "Deactivate" : user.activatedAt ? "Activate" : "Block sign-in",
      action: user.id !== req.user.id && !(user.hrEmployeeId && BLOCKED_HR_STATUSES.includes(user.hrStatus) && !user.isActive)
    })),
    showForm: false,
    postActions: syncOn ? [{ action: "/users/hr-sync", label: "Sync now" }] : [],
    summaryLines: [
      { label: syncOn
        ? `HR sync runs every ${Math.round(settings.hrSyncIntervalMs / 60000)} minutes for department ${settings.inventoryDepartmentCode}. ${describeHrSync(getLastHrSync())}`
        : "HR sync is off. Set HR_API_URL, HR_API_TOKEN and INVENTORY_DEPARTMENT_CODE in .env to enable it." },
      { label: `Sign-in mode: ${settings.essLoginMode === "live" ? "ESS (JVzPay) passwords; only the emergency admin uses a local password" : "local passwords"}.` },
      { label: "Resigned or terminated employees lose access at the next sync. Deactivating keeps audit history." }
    ]
  });
};

export const syncHrNow = async (req, res) => {
  if (!hrSyncConfigured(getSettings())) throw new Error("HR sync is not configured.");
  const run = await runHrSync();
  req.flash(run.ok ? "success_msg" : "error_msg", describeHrSync(run));
  res.redirect("/users");
};

export const editUserPage = async (req, res) => {
  const [user, roles] = await Promise.all([
    User.findByPk(Number(req.params.id), { include: Role }),
    Role.findAll({ order: [["name", "ASC"]] })
  ]);
  if (!user) throw new Error("User not found.");
  const roleOptions = roles.map(role => ({ value: role.id, label: role.name }));
  if (user.hrEmployeeId) {
    const { rules } = parsePositionRoleMap(getSettings().positionRoleMap);
    return renderModule(res, {
      title: `Edit ${user.name}`,
      subtitle: "Name, email and password come from HR and ESS. Only the role can be changed here.",
      section: "users",
      showForm: true,
      showTable: false,
      showActions: false,
      formTitle: "Role",
      formAction: `/users/${user.id}/update`,
      details: [
        { label: "Email", value: user.email },
        { label: "Employee ID", value: user.hrEmployeeId },
        { label: "Position", value: user.position || "—" },
        { label: "Role from position", value: roleForPosition(user.position, rules) }
      ],
      fields: makeFields([
        ["roleSource", "Role source", "select", true, [
          { value: "hr", label: "Use HR position mapping" },
          { value: "manual", label: "Manual override (choose below)" }
        ]],
        ["roleId", "Role (used for manual override)", "select", true, roleOptions]
      ], { roleSource: user.roleOverridden ? "manual" : "hr", roleId: user.RoleId })
    });
  }
  renderModule(res, {
    title: `Edit ${user.name}`,
    section: "users",
    showForm: true,
    showActions: false,
    formTitle: "Account details",
    formAction: `/users/${user.id}/update`,
    fields: makeFields([
      ["name", "Full name", "text", true],
      ["email", "Email address", "email", true],
      ["password", "New password (leave blank to keep current)", "password"],
      ["roleId", "Role", "select", true, roleOptions]
    ], { ...user.toJSON(), password: "", roleId: user.RoleId })
  });
};

export const updateUser = async (req, res) => {
  const user = await User.findByPk(Number(req.params.id));
  if (!user) throw new Error("User not found.");

  if (user.hrEmployeeId) {
    const roleSource = String(req.body.roleSource || "");
    let role = null;
    if (roleSource === "hr") {
      const { rules } = parsePositionRoleMap(getSettings().positionRoleMap);
      role = await Role.findOne({ where: { name: roleForPosition(user.position, rules) } });
    } else if (roleSource === "manual") {
      role = await Role.findByPk(Number(req.body.roleId));
    }
    if (!role) throw new Error("Choose a valid role source and role.");
    await user.update({ RoleId: role.id, role: role.name, roleOverridden: roleSource === "manual" });
    req.flash("success_msg", `Role set to ${role.name}${roleSource === "manual" ? " (manual override)" : " (from HR position)"}.`);
    return res.redirect("/users");
  }

  const role = await Role.findByPk(Number(req.body.roleId));
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!role || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Provide a valid user, name, email, and role.");
  const duplicate = await User.findOne({ where: { email } });
  if (duplicate && duplicate.id !== user.id) throw new Error("That email address is already registered.");
  const password = String(req.body.password || "");
  const updates = { name, email, RoleId: role.id, role: role.name };
  if (password) {
    if (!validPassword(password)) throw new Error("Passwords must be between 10 and 72 UTF-8 bytes.");
    updates.password = await bcrypt.hash(password, 12);
  }
  await user.update(updates);
  req.flash("success_msg", "User account updated.");
  res.redirect("/users");
};

// Active -> Inactive (and signed out); Inactive -> Active; "Pending first ESS sign-in"
// -> blocked, so an ESS sign-in no longer activates it.
export const toggleUser = async (req, res) => {
  const user = await User.findByPk(Number(req.params.id));
  if (!user) throw new Error("User not found.");
  if (user.id === req.user.id) throw new Error("You cannot deactivate your own account.");
  if (!user.isActive && user.hrEmployeeId && BLOCKED_HR_STATUSES.includes(user.hrStatus)) {
    throw new Error(`HR lists this employee as ${user.hrStatus}; access cannot be restored here.`);
  }
  if (user.isActive) {
    await user.update({ isActive: false });
    await endUserSessions(user.id);
    req.flash("success_msg", "User deactivated and signed out.");
  } else if (!user.activatedAt) {
    await user.update({ activatedAt: new Date() });
    req.flash("success_msg", "Sign-in blocked. Use Activate to allow access later.");
  } else {
    await user.update({ isActive: true });
    req.flash("success_msg", "User activated.");
  }
  res.redirect("/users");
};
