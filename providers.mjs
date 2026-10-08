import { createHmac, timingSafeEqual } from "node:crypto";

export class ProviderError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

const TWELVEDATA_INTERVALS = Object.freeze({
  "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1day"
});

export async function fetchTwelveDataSeries({ symbol, interval, apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw new ProviderError("Market data is not configured", 503);
  const providerInterval = TWELVEDATA_INTERVALS[interval];
  if (!providerInterval) throw new ProviderError("Unsupported timeframe", 400);
  const url = new URL("https://api.twelvedata.com/time_series");
  url.search = new URLSearchParams({ symbol, interval: providerInterval, outputsize: "200", apikey: apiKey }).toString();
  const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new ProviderError("Market data provider request failed", 502);
  let payload;
  try { payload = await response.json(); }
  catch { throw new ProviderError("Market data provider returned an invalid response", 502); }
  if (!Array.isArray(payload.values)) {
    // Do not return provider messages, request URLs, or credential-bearing query strings to the browser.
    throw new ProviderError("Market data is temporarily unavailable", 502);
  }
  const values = payload.values.map((row) => ({
    time: row.datetime,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close)
  })).filter((row) => row.time && [row.open, row.high, row.low, row.close].every(Number.isFinite))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return { source: "twelvedata", symbol, interval, values };
}

export function canonicalNowPaymentsBody(value) {
  if (Array.isArray(value)) return value.map(canonicalNowPaymentsBody);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalNowPaymentsBody(value[key])]));
  }
  return value;
}

export function verifyNowPaymentsSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  let parsed;
  try { parsed = JSON.parse(rawBody); }
  catch { return false; }
  const expected = createHmac("sha512", secret).update(JSON.stringify(canonicalNowPaymentsBody(parsed))).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  let actualBuffer;
  try { actualBuffer = Buffer.from(signature, "hex"); }
  catch { return false; }
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
 * Private NowPayments adapter. Call only from an authenticated server-side order flow
 * after the server has loaded an approved fee and persisted an idempotent order.
 * There is intentionally no client-side payment-key or simulated-payment fallback.
 */
export async function createNowPaymentsInvoice({ amount, currency, orderId, description, successUrl, cancelUrl, apiKey, ipnCallbackUrl, fetchImpl = fetch }) {
  if (!apiKey) throw new ProviderError("Payment provider is not configured", 503);
  if (!Number.isFinite(amount) || amount <= 0 || !orderId || !currency) {
    throw new ProviderError("Invalid server-side order", 400);
  }
  const response = await fetchImpl("https://api.nowpayments.io/v1/invoice", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      price_amount: amount,
      price_currency: currency.toLowerCase(),
      order_id: orderId,
      order_description: description,
      ipn_callback_url: ipnCallbackUrl,
      success_url: successUrl,
      cancel_url: cancelUrl
    }),
    signal: AbortSignal.timeout(12000)
  });
  let result;
  try { result = await response.json(); }
  catch { throw new ProviderError("Payment provider returned an invalid response", 502); }
  if (!response.ok || !result.invoice_url || !result.id) {
    // Never include provider payloads, secrets, or request URL in client-visible errors.
    throw new ProviderError("Could not create a hosted payment invoice", 502);
  }
  return { invoiceId: String(result.id), invoiceUrl: String(result.invoice_url), providerStatus: String(result.payment_status || "waiting") };
}
