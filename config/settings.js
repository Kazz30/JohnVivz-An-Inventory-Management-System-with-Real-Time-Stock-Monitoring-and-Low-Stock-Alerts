// Central place for integration and sign-in settings. Read on every call so tests
// and operators can change process.env without restarting module state.

export const ESS_LOGIN_MODES = ["local", "live"];
// HR's Inventory titles. Rules match when the text appears in the title (case-insensitive),
// first match wins; titles that match nothing become staff.
export const DEFAULT_POSITION_ROLE_MAP = "Inventory Manager=manager,Inventory Supervisor=supervisor,Inventory Staff=staff";
// Team decision: employees on leave may still sign in.
export const DEFAULT_ESS_ALLOWED_STATUSES = "Active,On Leave";

const trimUrl = value => String(value || "").trim().replace(/\/+$/, "");
const positiveInt = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};
const list = value => String(value || "").split(",").map(item => item.trim()).filter(Boolean);

export const getSettings = (env = process.env) => {
  const requestedMode = String(env.ESS_LOGIN_MODE || "local").trim().toLowerCase();
  return {
    hrApiUrl: trimUrl(env.HR_API_URL),
    hrApiToken: String(env.HR_API_TOKEN || "").trim(),
    jvzpayApiUrl: trimUrl(env.JVZPAY_API_URL),
    jvzpayApiToken: String(env.JVZPAY_API_TOKEN || "").trim(),
    inventoryDepartmentCode: String(env.INVENTORY_DEPARTMENT_CODE || "").trim(),
    // Anything other than an explicit "live" keeps today's local password sign-in.
    essLoginMode: ESS_LOGIN_MODES.includes(requestedMode) ? requestedMode : "local",
    essLoginModeInvalid: !ESS_LOGIN_MODES.includes(requestedMode),
    essAllowedStatuses: list(env.ESS_ALLOWED_STATUSES || DEFAULT_ESS_ALLOWED_STATUSES),
    emergencyAdminEmail: String(env.EMERGENCY_ADMIN_EMAIL || "").trim().toLowerCase(),
    positionRoleMap: String(env.POSITION_ROLE_MAP || DEFAULT_POSITION_ROLE_MAP),
    hrSyncIntervalMs: positiveInt(env.HR_SYNC_INTERVAL_MS, 5 * 60 * 1000),
    externalRequestTimeoutMs: positiveInt(env.EXTERNAL_REQUEST_TIMEOUT_MS, 8000)
  };
};

export const hrSyncConfigured = settings =>
  Boolean(settings.hrApiUrl && settings.hrApiToken && settings.inventoryDepartmentCode);
