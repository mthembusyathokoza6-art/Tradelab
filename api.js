const API_ROOT = "/api";

export class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export async function apiRequest(path, options = {}) {
  const method = options.method || "GET";
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  const init = {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, init);
  } catch {
    throw new ApiError("The secure API is not available in this preview.");
  }

  const raw = await response.text();
  let payload = {};
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = { message: "The secure API is not configured on this deployment yet." }; }
  }
  if (!response.ok) {
    throw new ApiError(payload.error || payload.message || `Request failed (${response.status}).`, response.status, payload);
  }
  return payload;
}
