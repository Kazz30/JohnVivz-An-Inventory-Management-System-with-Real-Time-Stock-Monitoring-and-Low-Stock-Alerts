// Maps an HR position title to an Inventory role.
// POSITION_ROLE_MAP holds ordered "text=role" rules separated by commas or semicolons,
// e.g. "Manager=manager,Supervisor=supervisor". The first rule whose text appears in the
// title (case-insensitive) wins; titles that match no rule get "staff".
import { DEFAULT_POSITION_ROLE_MAP } from "../config/settings.js";

export const INVENTORY_ROLES = ["manager", "supervisor", "staff"];
export const DEFAULT_ROLE = "staff";

export const parsePositionRoleMap = (text = DEFAULT_POSITION_ROLE_MAP) => {
  const rules = [];
  const errors = [];
  for (const entry of String(text).split(/[,;]/).map(item => item.trim()).filter(Boolean)) {
    const separator = entry.lastIndexOf("=");
    const pattern = separator > 0 ? entry.slice(0, separator).trim() : "";
    const role = separator > 0 ? entry.slice(separator + 1).trim().toLowerCase() : "";
    if (!pattern || !INVENTORY_ROLES.includes(role)) {
      errors.push(entry);
      continue;
    }
    rules.push({ pattern: pattern.toLowerCase(), role });
  }
  return { rules, errors };
};

export const roleForPosition = (position, rules) => {
  const title = String(position || "").toLowerCase();
  if (!title) return DEFAULT_ROLE;
  return rules.find(rule => title.includes(rule.pattern))?.role || DEFAULT_ROLE;
};
