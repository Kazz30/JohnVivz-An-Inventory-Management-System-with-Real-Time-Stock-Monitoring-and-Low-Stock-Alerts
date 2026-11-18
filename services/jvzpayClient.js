// Calls JVzPay's department login. The password goes straight to JVzPay and is never
// stored or logged by Inventory.
export const callJvzpayLogin = async ({ email, password, settings, fetchImpl = globalThis.fetch }) => {
  if (!settings.jvzpayApiUrl || !settings.jvzpayApiToken) {
    return { kind: "unavailable", reason: "jvzpay_not_configured" };
  }
  let response;
  try {
    response = await fetchImpl(`${settings.jvzpayApiUrl}/api/integration/v1/auth/login`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.jvzpayApiToken}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(settings.externalRequestTimeoutMs)
    });
  } catch {
    return { kind: "unavailable", reason: "jvzpay_unreachable" };
  }
  if (response.status === 200) {
    try {
      const body = await response.json();
      const employee = body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body;
      if (!employee || typeof employee !== "object" || !employee.employee_id) {
        return { kind: "unavailable", reason: "jvzpay_bad_response" };
      }
      return { kind: "ok", employee };
    } catch {
      return { kind: "unavailable", reason: "jvzpay_bad_response" };
    }
  }
  if (response.status === 401) {
    // A 401 about our own bearer token is a configuration fault, not a wrong password.
    const text = await response.text().catch(() => "");
    if (!/invalid_credentials/i.test(text) && /token|bearer|api[ _-]?key/i.test(text)) {
      return { kind: "unavailable", reason: "jvzpay_token_rejected" };
    }
    return { kind: "rejected", reason: "ess_invalid_credentials" };
  }
  if (response.status === 403) return { kind: "rejected", reason: "ess_not_allowed" };
  if (response.status === 429 || response.status >= 500) return { kind: "unavailable", reason: `jvzpay_http_${response.status}` };
  return { kind: "rejected", reason: `ess_http_${response.status}` };
};
