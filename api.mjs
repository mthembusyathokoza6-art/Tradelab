import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { canonicalNowPaymentsBody, createNowPaymentsInvoice, fetchTwelveDataSeries, verifyNowPaymentsSignature } from "./lib/providers.mjs";

const scrypt = promisify(nodeScrypt);
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const PUBLIC_SETTINGS = new Set([
  "inquiry_email", "inquiry_phone", "support_hours", "market_data_provider",
  "tradingview_enabled", "twelvedata_enabled", "whatsapp_enabled", "whatsapp_group_link",
  "whatsapp_popup_delay", "whatsapp_popup_message", "whatsapp_popup_title"
]);
const PUBLIC_CHALLENGE_BALANCES = [50000, 100000, 200000];
const APPROVED_CHALLENGES = Object.freeze({
  starter: { balance: 50000, fee: 500, targetPercent: 20, dailyLossPercent: 5, totalLossPercent: 15, tradingDays: 5 },
  professional: { balance: 100000, fee: 1000, targetPercent: 20, dailyLossPercent: 5, totalLossPercent: 15, tradingDays: 5 },
  elite: { balance: 200000, fee: 2500, targetPercent: 20, dailyLossPercent: 5, totalLossPercent: 15, tradingDays: 5 }
});
const TIMEFRAMES = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]);
const authRateBuckets = new Map();
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_MAX = 12;

class AppError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

function header(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : "";
}

function allowedOrigins() {
  const candidates = [process.env.APP_ORIGIN, process.env.ADMIN_ORIGIN, ...(process.env.TRUSTED_ORIGINS || "").split(",")];
  return new Set(candidates.map((value) => {
    try { return value ? new URL(value.trim()).origin : ""; }
    catch { return ""; }
  }).filter(Boolean));
}

function requestOriginFromEvent(event) {
  const forwardedHost = header(event, "x-forwarded-host").split(",")[0].trim();
  const host = forwardedHost || header(event, "host").split(",")[0].trim();
  const forwardedProto = header(event, "x-forwarded-proto").split(",")[0].trim().toLowerCase();
  let proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : "";
  if (!proto && event.rawUrl) {
    try { proto = new URL(event.rawUrl).protocol.replace(":", ""); } catch { /* Fall through to the origin header. */ }
  }
  if (!proto) {
    try { proto = new URL(header(event, "origin")).protocol.replace(":", ""); } catch { /* No browser origin available. */ }
  }
  if (host && (proto === "https" || proto === "http")) {
    try { return new URL(`${proto}://${host}`).origin; } catch { /* Use raw URL below. */ }
  }
  if (event.rawUrl) {
    try { return new URL(event.rawUrl).origin; } catch { /* Invalid raw URL. */ }
  }
  return "";
}

function isTrustedOrigin(event, origin) {
  if (!origin) return false;
  let normalized;
  try { normalized = new URL(origin).origin; } catch { return false; }
  return allowedOrigins().has(normalized) || normalized === requestOriginFromEvent(event);
}

function applyCors(event, headers) {
  const origin = header(event, "origin");
  if (origin && isTrustedOrigin(event, origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, X-Nowpayments-Sig";
    headers.Vary = "Origin";
  }
  return headers;
}

function respond(event, statusCode, body, extraHeaders = {}) {
  const headers = applyCors(event, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...extraHeaders
  });
  return { statusCode, headers, body: body === "" ? "" : JSON.stringify(body) };
}

function requireTrustedBrowserOrigin(event) {
  const origin = header(event, "origin");
  if (!isTrustedOrigin(event, origin)) {
    throw new AppError(403, "Request origin is not approved. Check the site origin and server APP_ORIGIN/ADMIN_ORIGIN settings.");
  }
}

// Best-effort per-function-instance throttle. Add a platform/WAF rate limit before production;
// Netlify functions are serverless, so this in-memory counter is not a global limiter.
function enforceAuthRateLimit(event, scope) {
  const now = Date.now();
  const forwarded = header(event, "x-forwarded-for").split(",")[0].trim();
  const clientIp = header(event, "x-nf-client-connection-ip") || forwarded || "unknown-client";
  const key = `${scope}:${clientIp}`;
  const current = authRateBuckets.get(key);
  if (!current || now - current.start >= AUTH_RATE_WINDOW_MS) {
    authRateBuckets.set(key, { start: now, count: 1 });
  } else {
    current.count += 1;
    if (current.count > AUTH_RATE_MAX) throw new AppError(429, "Too many attempts. Try again later.");
  }
  if (authRateBuckets.size > 2000) {
    for (const [bucketKey, value] of authRateBuckets) {
      if (now - value.start >= AUTH_RATE_WINDOW_MS) authRateBuckets.delete(bucketKey);
    }
  }
}

function getRoute(event) {
  const rawPath = event.path || "/";
  let path = rawPath.replace(/^\/.netlify\/functions\/api(?=\/|$)/, "");
  path = path.replace(/^\/api(?=\/|$)/, "");
  if (!path) path = "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return path;
}

function requestUrl(event) {
  const rawUrl = event.rawUrl || event.path || "http://localhost/";
  try { return new URL(rawUrl, "http://localhost"); }
  catch { return new URL("http://localhost/"); }
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (Buffer.byteLength(raw, "utf8") > 32_000) throw new AppError(413, "Request is too large.");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Object required");
    return parsed;
  } catch { throw new AppError(400, "Invalid JSON request."); }
}

function rawRequestBody(event) {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function requireSupabase() {
  const rawUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceKey) throw new AppError(503, "Secure data service is not configured.");
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch { throw new AppError(503, "Secure data service is not configured."); }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) throw new AppError(503, "Secure data service must use HTTPS.");
  return { url: parsed.origin.replace(/\/$/, ""), serviceKey };
}

async function supabaseRequest(path, { method = "GET", body, prefer = "", headers = {} } = {}) {
  const { url, serviceKey } = requireSupabase();
  let response;
  try {
    response = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new AppError(503, "Secure data service is temporarily unavailable.");
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch { payload = null; }
  }
  if (!response.ok) {
    const errorCode = payload && typeof payload.code === "string" ? payload.code : "";
    const status = errorCode === "23505" ? 409 : (response.status >= 500 ? 503 : response.status);
    throw new AppError(status, errorCode === "23505" ? "This email address is already registered." : "Secure data request could not be completed.", errorCode);
  }
  return payload;
}

function queryString(values) {
  return new URLSearchParams(values).toString();
}

async function getPublicInstrumentRows() {
  const params = queryString({ select: "*", order: "symbol.asc" });
  const rows = await supabaseRequest(`instruments?${params}`);
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row.is_active !== false && row.active !== false);
}

function safeInstrument(row) {
  return {
    id: row.id === undefined ? null : String(row.id),
    symbol: String(row.symbol ?? row.ticker ?? row.code ?? "").trim(),
    display_name: String(row.display_name ?? row.name ?? row.label ?? row.symbol ?? "").trim(),
    asset_class: String(row.asset_class ?? row.category ?? "").trim(),
    provider_symbol: String(row.data_provider_symbol ?? row.provider_symbol ?? row.market_data_symbol ?? row.symbol ?? "").trim(),
    is_active: row.is_active !== false && row.active !== false
  };
}

function safeChallenge(row, index) {
  const storedBalance = Number(row.virtual_balance ?? row.starting_balance ?? row.balance ?? row.account_size ?? row.initial_balance);
  const balance = PUBLIC_CHALLENGE_BALANCES.includes(storedBalance) ? storedBalance : PUBLIC_CHALLENGE_BALANCES[index] ?? 0;
  return {
    id: row.id === undefined ? `catalogue-${index + 1}` : String(row.id),
    name: String(row.name ?? row.title ?? `R${balance.toLocaleString("en-ZA")} Challenge`).trim(),
    balance,
    feeZar: ({ 50000: 500, 100000: 1000, 200000: 2500 })[balance] ?? null,
    currency: "ZAR",
    profitTargetPercent: 20,
    dailyLossPercent: 5,
    maxLossPercent: 15,
    minTradingDays: 5,
    feeStatus: "approved"
  };
}

function parseCookieHeader(event) {
  const raw = header(event, "cookie");
  const values = {};
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

function usesSecureCookie(event) {
  const origin = header(event, "origin");
  const protocol = header(event, "x-forwarded-proto").split(",")[0].trim();
  return origin.startsWith("https://") || protocol === "https" || process.env.NODE_ENV === "production";
}

function sessionCookieName(event) {
  return usesSecureCookie(event) ? "__Host-tradelab_session" : "tradelab_session";
}

function setSessionCookie(event, token, maxAge = COOKIE_MAX_AGE) {
  const secure = usesSecureCookie(event);
  const name = sessionCookieName(event);
  return `${name}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(event) {
  const secure = usesSecureCookie(event);
  const name = sessionCookieName(event);
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function pepper() {
  if (!process.env.SESSION_PEPPER || process.env.SESSION_PEPPER.length < 32) {
    throw new AppError(503, "Secure session service is not configured.");
  }
  return process.env.SESSION_PEPPER;
}

function hashOpaqueToken(token) {
  return createHash("sha256").update(`${pepper()}:${token}`).digest("hex");
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const params = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const derived = await scrypt(password, salt, 64, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![16384, 32768].includes(N) || r !== 8 || p !== 1) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch { return false; }
  if (salt.length !== 16 || expected.length !== 64) return false;
  try {
    const actual = Buffer.from(await scrypt(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 }));
    return timingSafeEqual(actual, expected);
  } catch { return false; }
}

function validateEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, "Enter a valid email address.");
  return email;
}

function validateDateOfBirth(value) {
  const raw = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new AppError(400, "Enter a valid date of birth.");
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw || parsed.getTime() > Date.now()) {
    throw new AppError(400, "Enter a valid date of birth.");
  }
  return raw;
}

function legalConfiguration() {
  const versions = {
    terms: process.env.LEGAL_TERMS_VERSION || "",
    risk: process.env.LEGAL_RISK_VERSION || "",
    privacy: process.env.LEGAL_PRIVACY_VERSION || ""
  };
  if (!versions.terms || !versions.risk || !versions.privacy) {
    throw new AppError(503, "Registration is disabled until the legal documents and version records are approved.");
  }
  return versions;
}

function emailVerificationRequired() {
  return process.env.EMAIL_VERIFICATION_REQUIRED === "true";
}

function optionalVerificationEmailConfigured() {
  return Boolean(process.env.EMAIL_API_URL && process.env.EMAIL_API_KEY && process.env.EMAIL_FROM && process.env.APP_ORIGIN);
}

function emailConfiguration() {
  const config = { url: process.env.EMAIL_API_URL || "", key: process.env.EMAIL_API_KEY || "", from: process.env.EMAIL_FROM || "" };
  if (!config.url || !config.key || !config.from) throw new AppError(503, "Email verification is not configured.");
  let parsed;
  try { parsed = new URL(config.url); }
  catch { throw new AppError(503, "Email verification is not configured."); }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) throw new AppError(503, "Email provider must use HTTPS.");
  return config;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function sendVerificationEmail(email, token) {
  const config = emailConfiguration();
  const appOrigin = process.env.APP_ORIGIN;
  if (!appOrigin) throw new AppError(503, "Registration email link is not configured.");
  const link = new URL("/verify-email.html", appOrigin);
  link.searchParams.set("token", token);
  const safeLink = escapeHtml(link.toString());
  const text = `Verify your TradeLab email address using this link: ${link.toString()}\n\nThe link expires in 24 hours. If you did not request this account, you can ignore this message.`;
  const html = `<p>Verify your TradeLab email address:</p><p><a href="${safeLink}">Verify email</a></p><p>This link expires in 24 hours. If you did not request this account, you can ignore this message.</p>`;
  let response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ from: config.from, to: email, subject: "Verify your TradeLab email", text, html }),
      signal: AbortSignal.timeout(10000)
    });
  } catch { throw new AppError(503, "Verification email could not be sent."); }
  if (!response.ok) throw new AppError(503, "Verification email could not be sent.");
}

async function createEmailVerification(userId, email) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashOpaqueToken(token);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
  await supabaseRequest("tradelab_email_verifications", {
    method: "POST",
    prefer: "return=minimal",
    body: { token_hash: tokenHash, user_id: userId, created_at: createdAt.toISOString(), expires_at: expiresAt.toISOString() }
  });
  await sendVerificationEmail(email, token);
}

async function findUserByEmail(email) {
  const params = queryString({
    select: "id,email,password_hash,tradelab_first_name,tradelab_last_name,tradelab_role,tradelab_account_status,tradelab_email_verified_at",
    email: `eq.${email}`,
    limit: "1"
  });
  const rows = await supabaseRequest(`users?${params}`);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

function publicUser(user) {
  return {
    id: String(user.id),
    email: String(user.email),
    firstName: String(user.tradelab_first_name || ""),
    lastName: String(user.tradelab_last_name || ""),
    fullName: `${user.tradelab_first_name || ""} ${user.tradelab_last_name || ""}`.trim(),
    role: String(user.tradelab_role || "trader")
  };
}

async function createSession(event, user) {
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + COOKIE_MAX_AGE * 1000);
  const userAgent = header(event, "user-agent").slice(0, 300);
  await supabaseRequest("tradelab_sessions", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      token_hash: hashOpaqueToken(token),
      user_id: user.id,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      user_agent: userAgent || null
    }
  });
  return token;
}

async function currentSessionUser(event) {
  const cookies = parseCookieHeader(event);
  const token = cookies[sessionCookieName(event)] || cookies["__Host-tradelab_session"] || cookies.tradelab_session;
  if (!token) return null;
  const tokenHash = hashOpaqueToken(token);
  const params = queryString({
    select: "user_id,expires_at,revoked_at",
    token_hash: `eq.${tokenHash}`,
    revoked_at: "is.null",
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1"
  });
  const sessions = await supabaseRequest(`tradelab_sessions?${params}`);
  const session = Array.isArray(sessions) ? sessions[0] : null;
  if (!session) return null;
  const userParams = queryString({
    select: "id,email,tradelab_first_name,tradelab_last_name,tradelab_role,tradelab_account_status,tradelab_email_verified_at",
    id: `eq.${session.user_id}`,
    limit: "1"
  });
  const users = await supabaseRequest(`users?${userParams}`);
  const user = Array.isArray(users) ? users[0] : null;
  if (!user || user.tradelab_account_status !== "active") return null;
  return user;
}

async function requireUser(event) {
  const user = await currentSessionUser(event);
  if (!user) throw new AppError(401, "Sign in is required.");
  return user;
}

async function register(event) {
  requireTrustedBrowserOrigin(event);
  enforceAuthRateLimit(event, "register");
  const body = parseBody(event);
  const versions = legalConfiguration();
  const requireEmailVerification = emailVerificationRequired();
  if (requireEmailVerification) emailConfiguration();
  if (body.termsAccepted !== true || body.riskAccepted !== true || body.privacyAcknowledged !== true) {
    throw new AppError(400, "Review and acknowledge each required document.");
  }
  const email = validateEmail(body.email);
  const firstName = String(body.firstName || "").trim();
  const lastName = String(body.lastName || "").trim();
  const phone = String(body.phone || "").trim();
  const country = String(body.country || "").trim();
  const dateOfBirth = validateDateOfBirth(body.dateOfBirth);
  const password = String(body.password || "");
  if (!firstName || firstName.length > 80 || !lastName || lastName.length > 80) throw new AppError(400, "Enter your first and last name.");
  if (!phone || phone.length > 40 || !country || country.length > 100) throw new AppError(400, "Enter a valid phone number and country.");
  if (password.length < 12 || password.length > 128) throw new AppError(400, "Password must be between 12 and 128 characters.");
  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  let createdId;
  try {
    const result = await supabaseRequest("rpc/tradelab_register_custom_user", {
      method: "POST",
      body: {
        p_id: id,
        p_email: email,
        p_password_hash: passwordHash,
        p_first_name: firstName,
        p_last_name: lastName,
        p_phone: phone,
        p_country: country,
        p_date_of_birth: dateOfBirth,
        p_terms_version: versions.terms,
        p_risk_version: versions.risk,
        p_privacy_version: versions.privacy,
        p_email_verification_required: requireEmailVerification
      }
    });
    createdId = typeof result === "string" ? result : result?.tradelab_register_custom_user ?? id;
  } catch (error) {
    if (error instanceof AppError && error.code === "23505") throw new AppError(409, "An account with that email already exists.");
    throw error;
  }
  let verificationEmailSent = false;
  if (requireEmailVerification || optionalVerificationEmailConfigured()) {
    try {
      await createEmailVerification(createdId, email);
      verificationEmailSent = true;
    } catch (error) {
      console.error("[auth] verification dispatch failed", error.code || error.status || "unknown");
      if (requireEmailVerification) {
        throw new AppError(503, "Your account request was saved, but verification email could not be sent. Use resend verification or contact support.");
      }
    }
  }
  if (requireEmailVerification) {
    return { message: "Account created. Check your email for a verification link.", emailVerificationRequired: true };
  }
  return {
    message: verificationEmailSent
      ? "Account created. You can sign in now; verify your email before requesting a payout."
      : "Account created. You can sign in now. Email verification is required before requesting a payout.",
    emailVerificationRequired: false,
    payoutEmailVerificationRequired: true,
    verificationEmailSent
  };
}

async function resendVerification(event) {
  requireTrustedBrowserOrigin(event);
  enforceAuthRateLimit(event, "resend-verification");
  const body = parseBody(event);
  const email = validateEmail(body.email);
  // Keep the outward response identical whether or not this email has an account.
  try {
    const user = await findUserByEmail(email);
    if (user && !user.tradelab_email_verified_at) await createEmailVerification(user.id, email);
  } catch (error) {
    console.error("[auth] resend verification failed", error.code || error.status || "unknown");
  }
  return { message: "If an eligible account exists, a verification email will be sent." };
}

async function verifyEmail(event) {
  requireTrustedBrowserOrigin(event);
  enforceAuthRateLimit(event, "verify-email");
  const body = parseBody(event);
  const token = String(body.token || "");
  if (token.length < 32 || token.length > 256) throw new AppError(400, "Verification link is invalid or expired.");
  const tokenHash = hashOpaqueToken(token);
  const params = queryString({
    select: "token_hash,user_id,expires_at,consumed_at",
    token_hash: `eq.${tokenHash}`,
    consumed_at: "is.null",
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1"
  });
  const tokens = await supabaseRequest(`tradelab_email_verifications?${params}`);
  const record = Array.isArray(tokens) ? tokens[0] : null;
  if (!record) throw new AppError(400, "Verification link is invalid or expired.");
  const userQuery = queryString({ select: "id,tradelab_account_status,tradelab_email_verified_at", id: `eq.${record.user_id}`, limit: "1" });
  const matchedUsers = await supabaseRequest(`users?${userQuery}`);
  const matchedUser = Array.isArray(matchedUsers) ? matchedUsers[0] : null;
  const verificationEligibleStatuses = new Set(["pending_verification", "active"]);
  if (!matchedUser || !verificationEligibleStatuses.has(matchedUser.tradelab_account_status)) {
    throw new AppError(400, "Verification link is invalid or expired.");
  }
  if (!matchedUser.tradelab_email_verified_at) {
    const userFilter = queryString({
      select: "id",
      id: `eq.${record.user_id}`,
      tradelab_account_status: "in.(pending_verification,active)",
      tradelab_email_verified_at: "is.null"
    });
    const updatedUsers = await supabaseRequest(`users?${userFilter}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: { tradelab_email_verified_at: new Date().toISOString(), tradelab_account_status: "active" }
    });
    if (!Array.isArray(updatedUsers) || updatedUsers.length !== 1) throw new AppError(400, "Verification link is invalid or expired.");
  }
  await supabaseRequest(`tradelab_email_verifications?${queryString({ token_hash: `eq.${tokenHash}` })}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { consumed_at: new Date().toISOString() }
  });
  return { message: "Email address verified. It will count toward future payout checks." };
}

async function login(event) {
  requireTrustedBrowserOrigin(event);
  enforceAuthRateLimit(event, "login");
  const body = parseBody(event);
  const email = validateEmail(body.email);
  const password = String(body.password || "");
  if (!password || password.length > 128) throw new AppError(400, "Enter a valid email and password.");
  const user = await findUserByEmail(email);
  const valid = user ? await verifyPassword(password, user.password_hash) : false;
  if (!valid) throw new AppError(401, "Email or password is incorrect.");
  if (user.tradelab_account_status !== "active") throw new AppError(403, "This account is not active.");
  const token = await createSession(event, user);
  return {
    body: { user: publicUser(user) },
    headers: { "Set-Cookie": setSessionCookie(event, token) }
  };
}

async function logout(event) {
  requireTrustedBrowserOrigin(event);
  const cookies = parseCookieHeader(event);
  const token = cookies[sessionCookieName(event)] || cookies["__Host-tradelab_session"] || cookies.tradelab_session;
  if (token) {
    const tokenHash = hashOpaqueToken(token);
    await supabaseRequest(`tradelab_sessions?${queryString({ token_hash: `eq.${tokenHash}`, revoked_at: "is.null" })}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { revoked_at: new Date().toISOString() }
    });
  }
  return { body: { message: "Signed out." }, headers: { "Set-Cookie": clearSessionCookie(event) } };
}

async function listChallenges() {
  const params = queryString({ select: "*", order: "id.asc" });
  const rows = await supabaseRequest(`challenges?${params}`);
  if (!Array.isArray(rows)) return [];
  const active = rows.filter((row) => row.is_active !== false && row.active !== false);
  active.sort((a, b) => Number(a.virtual_balance ?? a.starting_balance ?? a.balance ?? a.account_size ?? 0) - Number(b.virtual_balance ?? b.starting_balance ?? b.balance ?? b.account_size ?? 0));
  return active.slice(0, 3).map(safeChallenge);
}

async function listInstruments() {
  const rows = await getPublicInstrumentRows();
  return rows.map(safeInstrument).filter((row) => row.symbol);
}

async function publicSettings() {
  // Ask PostgREST for public allowlisted keys only; secret rows are not fetched by this endpoint.
  const params = queryString({ select: "key,value", key: `in.(${[...PUBLIC_SETTINGS].join(",")})` });
  const rows = await supabaseRequest(`settings?${params}`);
  const result = {};
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const key = String(row.key || "");
      if (PUBLIC_SETTINGS.has(key)) result[key] = row.value;
    }
  }
  return result;
}

function providerSymbol(instrument, requestedSymbol) {
  const candidate = instrument.provider_symbol || requestedSymbol;
  const normalized = candidate.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized === "XAUUSD") return "XAU/USD";
  if (normalized === "XAGUSD") return "XAG/USD";
  if (/^[A-Z]{6}$/.test(normalized)) return `${normalized.slice(0, 3)}/${normalized.slice(3)}`;
  return candidate;
}

async function marketSeries(url) {
  const requestedSymbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
  const interval = String(url.searchParams.get("interval") || "15m");
  if (!requestedSymbol || requestedSymbol.length > 24 || !/^[A-Z0-9._/-]+$/.test(requestedSymbol)) throw new AppError(400, "Select a valid instrument.");
  if (!TIMEFRAMES.has(interval)) throw new AppError(400, "Unsupported timeframe.");
  const instruments = (await getPublicInstrumentRows()).map(safeInstrument);
  const instrument = instruments.find((row) => row.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "") === requestedSymbol.replace(/[^A-Z0-9]/g, ""));
  if (!instrument) throw new AppError(404, "Instrument is not available.");
  const result = await fetchTwelveDataSeries({ symbol: providerSymbol(instrument, requestedSymbol), interval, apiKey: process.env.TWELVEDATA_API_KEY });
  return { ...result, symbol: requestedSymbol };
}

async function getCurrentUser(event) {
  const user = await requireUser(event);
  return { user: publicUser(user) };
}

async function listUserChallengeAccounts(event) {
  const user = await requireUser(event);
  // Filter on the authenticated user's server-side ID; no client-supplied user ID is trusted.
  const params = queryString({ select: "*", user_id: `eq.${user.id}`, limit: "100" });
  const rows = await supabaseRequest(`challenge_accounts?${params}`);
  if (!Array.isArray(rows)) return [];
  const catalogueRows = await supabaseRequest(`challenges?${queryString({ select: "*" })}`);
  const catalogue = Array.isArray(catalogueRows) ? catalogueRows : [];
  const mappedChallenges = catalogue.map((row, index) => safeChallenge(row, index));
  return rows.map((row) => {
    const challengeId = String(row.challenge_id ?? row.challengeId ?? "");
    const challenge = mappedChallenges.find((item) => item.id === challengeId);
    const startingBalance = Number(row.starting_balance ?? row.virtual_balance ?? row.initial_balance ?? row.balance ?? challenge?.balance ?? 0);
    const equity = Number(row.equity ?? row.current_equity ?? row.current_balance ?? row.account_balance ?? startingBalance);
    return {
      id: String(row.id ?? row.account_id ?? ""),
      challengeId,
      challengeName: challenge?.name || "Challenge account",
      status: String(row.status ?? row.account_status ?? row.state ?? "unknown"),
      startingBalance: Number.isFinite(startingBalance) ? startingBalance : null,
      equity: Number.isFinite(equity) ? equity : null,
      createdAt: row.created_at ?? row.createdAt ?? null
    };
  });
}

async function adminOverview(event) {
  const user = await requireUser(event);
  if (user.tradelab_role !== "admin") throw new AppError(403, "Administrator access is required.");
  // Private admin data queries are deliberately not enabled until column-level allowlists,
  // audit logging, and server-side business workflows have been reviewed.
  throw new AppError(501, "Admin data endpoints are not enabled yet.");
}

function paymentProcessingEnabled() {
  return process.env.CHECKOUT_ENABLED === "true" && process.env.NOWPAYMENTS_WEBHOOK_ENABLED === "true";
}

function approvedChallengeRowMatches(row, approved) {
  return Boolean(row && row.is_active !== false &&
    Number(row.virtual_balance) === approved.balance && Number(row.price) === approved.fee &&
    String(row.currency || "ZAR").toUpperCase() === "ZAR" &&
    Number(row.profit_target_percent) === approved.targetPercent &&
    Number(row.max_daily_dd_percent) === approved.dailyLossPercent &&
    Number(row.max_total_dd_percent) === approved.totalLossPercent &&
    Number(row.min_trading_days) === approved.tradingDays);
}

async function checkoutRuntimeReady() {
  if (!paymentProcessingEnabled() || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !process.env.SESSION_PEPPER || !process.env.NOWPAYMENTS_API_KEY || !process.env.NOWPAYMENTS_IPN_SECRET ||
      !process.env.APP_ORIGIN || !process.env.LEGAL_TERMS_VERSION || !process.env.LEGAL_RISK_VERSION || !process.env.LEGAL_PRIVACY_VERSION) return false;
  try {
    const [orders, events, legal, challenges] = await Promise.all([
      supabaseRequest(`tradelab_payment_orders?${queryString({ select: "id,status,invoice_url,provider_invoice_id", limit: "0" })}`),
      supabaseRequest(`tradelab_payment_events?${queryString({ select: "id,payload_hash", limit: "0" })}`),
      supabaseRequest(`tradelab_legal_acceptances?${queryString({ select: "acceptance_id,user_id,document_type,document_version", limit: "0" })}`),
      supabaseRequest(`challenges?${queryString({ select: "id,name,virtual_balance,price,currency,profit_target_percent,max_daily_dd_percent,max_total_dd_percent,min_trading_days,is_active", id: `in.(${Object.keys(APPROVED_CHALLENGES).join(",")})` })}`)
    ]);
    if (!Array.isArray(orders) || !Array.isArray(events) || !Array.isArray(legal) || !Array.isArray(challenges)) return false;
    const byId = new Map(challenges.map((row) => [String(row.id), row]));
    return Object.entries(APPROVED_CHALLENGES).every(([id, approved]) => approvedChallengeRowMatches(byId.get(id), approved));
  } catch {
    return false;
  }
}

function requirePaymentConfiguration(event) {
  if (!paymentProcessingEnabled()) throw new AppError(503, "Checkout is not enabled on this deployment.");
  if (!process.env.NOWPAYMENTS_API_KEY || !process.env.NOWPAYMENTS_IPN_SECRET) {
    throw new AppError(503, "Payment provider is not configured.");
  }
  const rawOrigin = process.env.APP_ORIGIN || "";
  let appOrigin;
  try { appOrigin = new URL(rawOrigin); }
  catch { throw new AppError(503, "Payment return URL is not configured."); }
  const localHttp = appOrigin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(appOrigin.hostname);
  if (appOrigin.protocol !== "https:" && !localHttp) throw new AppError(503, "Payment return URL must use HTTPS.");
  if (appOrigin.origin !== requestOriginFromEvent(event)) throw new AppError(503, "Payment return URL does not match this site.");
  return appOrigin.origin;
}

async function requireCurrentLegalAcceptance(userId) {
  const versions = legalConfiguration();
  const params = queryString({
    select: "document_type,document_version",
    user_id: `eq.${userId}`,
    document_type: "in.(terms,risk,privacy)"
  });
  const rows = await supabaseRequest(`tradelab_legal_acceptances?${params}`);
  const accepted = Array.isArray(rows) ? rows : [];
  const hasCurrent = (type, version) => accepted.some((row) => String(row.document_type) === type && String(row.document_version) === version);
  if (!hasCurrent("terms", versions.terms) || !hasCurrent("risk", versions.risk) || !hasCurrent("privacy", versions.privacy)) {
    throw new AppError(403, "Accept the current Terms, Risk Disclaimer and Privacy Notice before checkout.");
  }
}

async function getApprovedChallengeForCheckout(challengeId) {
  const approved = APPROVED_CHALLENGES[challengeId];
  if (!approved) throw new AppError(404, "Challenge is not available for purchase.");
  const params = queryString({
    select: "id,name,virtual_balance,price,currency,profit_target_percent,max_daily_dd_percent,max_total_dd_percent,min_trading_days,is_active",
    id: `eq.${challengeId}`,
    limit: "1"
  });
  const rows = await supabaseRequest(`challenges?${params}`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || row.is_active === false) throw new AppError(404, "Challenge is not available for purchase.");
  if (!approvedChallengeRowMatches(row, approved)) {
    throw new AppError(503, "Challenge catalogue values do not match the approved fee and rules. Checkout remains locked until the catalogue is aligned.");
  }
  return { ...approved, id: String(row.id), name: String(row.name || challengeId), currency: "ZAR" };
}

async function getOrderByIdempotency(userId, idempotencyKey) {
  const params = queryString({
    select: "id,status,invoice_url,provider_invoice_id,fee_amount,fee_currency",
    user_id: `eq.${userId}`,
    idempotency_key: `eq.${idempotencyKey}`,
    limit: "1"
  });
  const rows = await supabaseRequest(`tradelab_payment_orders?${params}`);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

function existingCheckoutResponse(order) {
  if (order.status === "settled") throw new AppError(409, "This checkout request has already been paid.");
  if (["waiting", "confirming", "partially_paid"].includes(String(order.status)) && order.invoice_url) {
    return { orderId: String(order.id), invoiceUrl: String(order.invoice_url), status: String(order.status) };
  }
  throw new AppError(409, "This checkout request cannot be retried automatically. Do not pay again; contact support with your order reference.");
}

async function startCheckout(event) {
  requireTrustedBrowserOrigin(event);
  enforceAuthRateLimit(event, "checkout");
  const appOrigin = requirePaymentConfiguration(event);
  const user = await requireUser(event);
  await requireCurrentLegalAcceptance(user.id);
  const body = parseBody(event);
  const challengeId = String(body.challengeId || "").trim();
  const idempotencyKey = String(body.idempotencyKey || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
    throw new AppError(400, "A valid checkout request ID is required.");
  }

  const existing = await getOrderByIdempotency(user.id, idempotencyKey);
  if (existing) return existingCheckoutResponse(existing);
  const challenge = await getApprovedChallengeForCheckout(challengeId);
  const orderId = randomUUID();
  try {
    await supabaseRequest("tradelab_payment_orders", {
      method: "POST",
      prefer: "return=minimal",
      body: {
        id: orderId,
        user_id: user.id,
        challenge_id: challenge.id,
        challenge_name: challenge.name,
        starting_balance: challenge.balance,
        fee_amount: challenge.fee,
        fee_currency: challenge.currency,
        max_daily_loss: challenge.balance * challenge.dailyLossPercent / 100,
        max_total_loss: challenge.balance * challenge.totalLossPercent / 100,
        profit_target: challenge.targetPercent,
        profit_target_value: challenge.balance * challenge.targetPercent / 100,
        min_trading_days: challenge.tradingDays,
        idempotency_key: idempotencyKey,
        status: "creating"
      }
    });
  } catch (error) {
    if (error instanceof AppError && error.status === 409) {
      const duplicate = await getOrderByIdempotency(user.id, idempotencyKey);
      if (duplicate) return existingCheckoutResponse(duplicate);
    }
    throw error;
  }

  const successUrl = new URL("/accounts.html", appOrigin);
  successUrl.searchParams.set("payment", "return");
  successUrl.searchParams.set("order", orderId);
  const cancelUrl = new URL("/accounts.html", appOrigin);
  cancelUrl.searchParams.set("payment", "cancel");
  cancelUrl.searchParams.set("order", orderId);
  const webhookUrl = new URL("/api/webhooks/nowpayments", appOrigin);
  let invoice;
  try {
    invoice = await createNowPaymentsInvoice({
      amount: challenge.fee,
      currency: challenge.currency,
      orderId,
      description: `${challenge.name} simulated trading challenge`,
      successUrl: successUrl.toString(),
      cancelUrl: cancelUrl.toString(),
      apiKey: process.env.NOWPAYMENTS_API_KEY,
      ipnCallbackUrl: webhookUrl.toString()
    });
  } catch (error) {
    try {
      await supabaseRequest(`tradelab_payment_orders?${queryString({ id: `eq.${orderId}` })}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: { status: "invoice_error", provider_status: "invoice_creation_failed", updated_at: new Date().toISOString() }
      });
    } catch { /* Keep the original provider error; reconciliation can inspect the pending order. */ }
    throw error;
  }

  const updated = await supabaseRequest(`tradelab_payment_orders?${queryString({ id: `eq.${orderId}`, user_id: `eq.${user.id}` })}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status: "waiting",
      provider_invoice_id: invoice.invoiceId,
      invoice_url: invoice.invoiceUrl,
      provider_status: invoice.providerStatus,
      updated_at: new Date().toISOString()
    }
  });
  if (!Array.isArray(updated) || updated.length !== 1) throw new AppError(503, "Invoice was created but could not be linked to the order. Contact support before retrying.");
  return { orderId, invoiceUrl: invoice.invoiceUrl, status: "waiting" };
}

async function getOwnedPaymentOrder(event, orderId) {
  const user = await requireUser(event);
  const params = queryString({
    select: "id,challenge_name,fee_amount,fee_currency,status,provider_status,created_at,settled_at",
    id: `eq.${orderId}`,
    user_id: `eq.${user.id}`,
    limit: "1"
  });
  const rows = await supabaseRequest(`tradelab_payment_orders?${params}`);
  const order = Array.isArray(rows) ? rows[0] : null;
  if (!order) throw new AppError(404, "Payment order not found.");
  return {
    id: String(order.id),
    challengeName: String(order.challenge_name),
    amount: Number(order.fee_amount),
    currency: String(order.fee_currency),
    status: String(order.status),
    providerStatus: order.provider_status ? String(order.provider_status) : null,
    createdAt: order.created_at,
    settledAt: order.settled_at
  };
}

async function nowPaymentsWebhook(event) {
  if (process.env.NOWPAYMENTS_WEBHOOK_ENABLED !== "true") throw new AppError(404, "Webhook endpoint is disabled.");
  if (!process.env.NOWPAYMENTS_IPN_SECRET) throw new AppError(503, "Webhook verification is not configured.");
  const raw = rawRequestBody(event);
  if (!raw || Buffer.byteLength(raw, "utf8") > 64_000) throw new AppError(413, "Webhook payload is missing or too large.");
  const signature = header(event, "x-nowpayments-sig");
  if (!verifyNowPaymentsSignature(raw, signature, process.env.NOWPAYMENTS_IPN_SECRET)) throw new AppError(401, "Invalid webhook signature.");
  let payload;
  try { payload = JSON.parse(raw); }
  catch { throw new AppError(400, "Invalid webhook payload."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AppError(400, "Invalid webhook payload.");
  const orderId = String(payload.order_id || "").toLowerCase();
  const paymentId = String(payload.payment_id ?? "").trim();
  const paymentStatus = String(payload.payment_status || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(orderId) || !paymentId || paymentId.length > 100 || !paymentStatus || paymentStatus.length > 40) {
    throw new AppError(400, "Webhook payload is missing a valid order, payment ID or status.");
  }
  const finiteOrNull = (value) => value === undefined || value === null || value === "" ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  const payloadHash = createHash("sha256").update(JSON.stringify(canonicalNowPaymentsBody(payload))).digest("hex");
  let result;
  try {
    result = await supabaseRequest("rpc/tradelab_apply_nowpayments_event", {
      method: "POST",
      body: {
        p_order_id: orderId,
        p_payment_id: paymentId,
        p_invoice_id: payload.invoice_id === undefined || payload.invoice_id === null ? null : String(payload.invoice_id),
        p_payment_status: paymentStatus,
        p_price_amount: finiteOrNull(payload.price_amount),
        p_price_currency: payload.price_currency === undefined ? null : String(payload.price_currency),
        p_pay_currency: payload.pay_currency === undefined ? null : String(payload.pay_currency),
        p_pay_amount: finiteOrNull(payload.pay_amount),
        p_actually_paid: finiteOrNull(payload.actually_paid),
        p_payload: payload,
        p_payload_hash: payloadHash
      }
    });
  } catch (error) {
    console.error("[payments] verified webhook processing failed", error.code || error.status || "unknown");
    throw new AppError(503, "Verified payment notification could not be processed; provider retry is required.");
  }
  return { received: true, result: Array.isArray(result) ? result[0] : result };
}

export async function handler(event) {
  const method = String(event.httpMethod || "GET").toUpperCase();
  const path = getRoute(event);
  const url = requestUrl(event);
  if (method === "OPTIONS") return respond(event, 204, "");

  try {
    if (method === "GET" && (path === "/" || path === "/health")) {
      return respond(event, 200, {
        status: "ok",
        runtime: "netlify-functions",
        databaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
        marketDataConfigured: Boolean(process.env.TWELVEDATA_API_KEY),
        authConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SESSION_PEPPER),
        registrationConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SESSION_PEPPER && process.env.LEGAL_TERMS_VERSION && process.env.LEGAL_RISK_VERSION && process.env.LEGAL_PRIVACY_VERSION && (!emailVerificationRequired() || optionalVerificationEmailConfigured())),
        emailVerificationRequired: emailVerificationRequired(),
        optionalVerificationEmailConfigured: optionalVerificationEmailConfigured(),
        checkoutEnabled: await checkoutRuntimeReady()
      });
    }
    if (method === "GET" && path === "/challenges") return respond(event, 200, await listChallenges());
    if (method === "GET" && path === "/instruments") return respond(event, 200, await listInstruments());
    if (method === "GET" && path === "/settings/public") return respond(event, 200, await publicSettings());
    if (method === "GET" && path === "/market/series") return respond(event, 200, await marketSeries(url), { "Cache-Control": "public, max-age=15, stale-while-revalidate=30" });

    if (method === "POST" && path === "/auth/register") return respond(event, 201, await register(event));
    if (method === "POST" && path === "/auth/resend-verification") return respond(event, 200, await resendVerification(event));
    if (method === "POST" && path === "/auth/verify-email") return respond(event, 200, await verifyEmail(event));
    if (method === "POST" && path === "/auth/login") {
      const result = await login(event);
      return respond(event, 200, result.body, result.headers);
    }
    if (method === "GET" && path === "/auth/me") return respond(event, 200, await getCurrentUser(event));
    if (method === "GET" && path === "/account/challenges") return respond(event, 200, await listUserChallengeAccounts(event));
    const paymentOrderMatch = path.match(/^\/payments\/orders\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    if (method === "GET" && paymentOrderMatch) return respond(event, 200, await getOwnedPaymentOrder(event, paymentOrderMatch[1]));
    if (method === "POST" && path === "/auth/logout") {
      const result = await logout(event);
      return respond(event, 200, result.body, result.headers);
    }
    if (method === "GET" && path === "/admin/overview") return respond(event, 200, await adminOverview(event));
    if (method === "POST" && path === "/payments/checkout") return respond(event, 201, await startCheckout(event));
    if (method === "POST" && (path === "/webhooks/nowpayments" || path === "/payments/nowpayments/webhook")) {
      return respond(event, 200, await nowPaymentsWebhook(event));
    }

    return respond(event, 404, { error: "Endpoint not found." });
  } catch (error) {
    if (error instanceof AppError) return respond(event, error.status, { error: error.message });
    if (error?.name === "ProviderError") return respond(event, error.status || 502, { error: error.message });
    console.error("[api] unexpected failure", error?.code || error?.name || "unknown");
    return respond(event, 500, { error: "The request could not be completed." });
  }
}
