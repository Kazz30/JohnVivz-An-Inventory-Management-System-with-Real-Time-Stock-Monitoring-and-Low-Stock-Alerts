// Read-only client for the HR integration API (Bearer token issued by HR for Inventory).
// Only the fields Inventory needs are kept; salary and personal data are never read into
// the result, even if HR returns them.

export class HrApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "HrApiError";
    this.status = status;
  }
}

const MAX_PAGES = 500;
const PAGE_SIZE = 100;

const unwrapList = body => {
  const data = body?.data;
  if (Array.isArray(data)) return { items: data, meta: {} };
  if (Array.isArray(data?.items)) return { items: data.items, meta: data };
  throw new HrApiError("HR returned an unexpected response shape.");
};

export const normalizeEmployee = raw => {
  const employeeId = String(raw?.permanent_employee_id || "").trim();
  const email = String(raw?.email || "").trim().toLowerCase();
  if (!employeeId || employeeId.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) {
    return null;
  }
  return {
    employeeId,
    fullName: String(raw?.full_name || "").trim().slice(0, 120) || employeeId,
    email,
    departmentId: raw?.department?.department_id ?? null,
    departmentCode: String(raw?.department?.department_code || "").trim(),
    position: String(raw?.position || "").trim().slice(0, 160) || null,
    status: String(raw?.status || "").trim()
  };
};

export const createHrClient = ({ settings, fetchImpl = globalThis.fetch }) => {
  const request = async (path, { allowNotFound = false } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${settings.hrApiUrl}${path}`, {
        headers: { authorization: `Bearer ${settings.hrApiToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(settings.externalRequestTimeoutMs)
      });
    } catch (error) {
      throw new HrApiError(`HR API could not be reached: ${error.message}`);
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new HrApiError(`HR API answered ${response.status} for ${path.split("?")[0]}.`, response.status);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new HrApiError("HR API returned invalid JSON.");
    }
    if (body?.success === false) throw new HrApiError("HR API reported an unsuccessful request.");
    return body;
  };

  return {
    async listDepartments() {
      return unwrapList(await request("/api/integration/v1/departments")).items;
    },

    // Reads every page; throws if any page fails so a partial list never drives changes.
    async listEmployees({ departmentId } = {}) {
      const employees = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
        if (departmentId !== undefined && departmentId !== null) query.set("department_id", String(departmentId));
        const { items, meta } = unwrapList(await request(`/api/integration/v1/employees?${query}`));
        employees.push(...items);
        const totalPages = Number(meta.total_pages ?? meta.totalPages ?? meta.pagination?.total_pages ?? meta.pagination?.totalPages);
        const total = Number(meta.total ?? meta.total_items ?? meta.pagination?.total);
        if (Number.isFinite(totalPages) && totalPages > 0) {
          if (page >= totalPages) return employees;
        } else if (Number.isFinite(total) && total >= 0) {
          if (employees.length >= total) return employees;
        } else if (items.length < PAGE_SIZE) {
          return employees;
        }
        if (items.length === 0) return employees;
      }
      throw new HrApiError(`HR employee list exceeded ${MAX_PAGES} pages.`);
    },

    async getEmployee(identifier) {
      const body = await request(`/api/integration/v1/employees/${encodeURIComponent(identifier)}`, { allowNotFound: true });
      if (!body) return null;
      return body.data?.item ?? body.data ?? null;
    }
  };
};
