import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handler } from "../netlify/functions/api.mjs";
import { canonicalNowPaymentsBody } from "../netlify/functions/lib/providers.mjs";

test("hosted checkout and signed webhook fail closed and pass the server-side smoke path", async () => {
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  try {
    Object.assign(process.env, {
      SUPABASE_URL: "https://db.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-only",
      SESSION_PEPPER: "test-session-pepper-long-enough-for-tests",
      APP_ORIGIN: "https://public.example.test",
      CHECKOUT_ENABLED: "true",
      NOWPAYMENTS_WEBHOOK_ENABLED: "true",
      NOWPAYMENTS_API_KEY: "test-api-key",
      NOWPAYMENTS_IPN_SECRET: "test-ipn-secret",
      LEGAL_TERMS_VERSION: "terms-test-v1",
      LEGAL_RISK_VERSION: "risk-test-v1",
      LEGAL_PRIVACY_VERSION: "privacy-test-v1"
    });

    const user = {
      id: "5c6cfbd6-8a73-4cbb-8d0e-1e236eb8f1a1",
      email: "trader@example.test",
      tradelab_first_name: "Test",
      tradelab_last_name: "Trader",
      tradelab_role: "trader",
      tradelab_account_status: "active",
      tradelab_email_verified_at: null
    };
    const challenge = {
      id: "starter", name: "Starter Assessment", virtual_balance: 50000,
      price: 500, currency: "ZAR", profit_target_percent: 20,
      max_daily_dd_percent: 5, max_total_dd_percent: 15,
      min_trading_days: 5, is_active: true
    };
    const otherChallenges = [
      { id: "professional", name: "Professional Trader", virtual_balance: 100000, price: 1000, currency: "ZAR", profit_target_percent: 20, max_daily_dd_percent: 5, max_total_dd_percent: 15, min_trading_days: 5, is_active: true },
      { id: "elite", name: "Elite Performance", virtual_balance: 200000, price: 2500, currency: "ZAR", profit_target_percent: 20, max_daily_dd_percent: 5, max_total_dd_percent: 15, min_trading_days: 5, is_active: true }
    ];
    let order = null;
    let providerCalls = 0;
    let rpcArgs = null;
    let nextChallengeRules = challenge;

    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      const method = String(init.method || "GET").toUpperCase();
      if (url.hostname === "api.nowpayments.io") {
        providerCalls += 1;
        const requestBody = JSON.parse(init.body);
        assert.equal(requestBody.price_amount, 500);
        assert.equal(requestBody.price_currency, "zar");
        assert.equal(requestBody.order_id, order.id);
        return new Response(JSON.stringify({
          id: "invoice-test-1",
          invoice_url: "https://nowpayments.io/payment/?iid=invoice-test-1",
          payment_status: "waiting"
        }), { status: 200 });
      }
      if (url.pathname.endsWith("/tradelab_sessions")) {
        return new Response(JSON.stringify([{
          user_id: user.id,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          revoked_at: null
        }]), { status: 200 });
      }
      if (url.pathname.endsWith("/users")) return new Response(JSON.stringify([user]), { status: 200 });
      if (url.pathname.endsWith("/tradelab_payment_events")) return new Response("[]", { status: 200 });
      if (url.pathname.endsWith("/tradelab_legal_acceptances")) {
        return new Response(JSON.stringify([
          { document_type: "terms", document_version: "terms-test-v1" },
          { document_type: "risk", document_version: "risk-test-v1" },
          { document_type: "privacy", document_version: "privacy-test-v1" }
        ]), { status: 200 });
      }
      if (url.pathname.endsWith("/challenges")) {
        const requestedIds = url.searchParams.get("id") || "";
        return new Response(JSON.stringify(requestedIds.startsWith("in.") ? [nextChallengeRules, ...otherChallenges] : [nextChallengeRules]), { status: 200 });
      }
      if (url.pathname.endsWith("/tradelab_payment_orders") && method === "GET") {
        const key = url.searchParams.get("idempotency_key")?.replace(/^eq\./, "");
        return new Response(JSON.stringify(order?.idempotency_key === key ? [order] : []), { status: 200 });
      }
      if (url.pathname.endsWith("/tradelab_payment_orders") && method === "POST") {
        order = JSON.parse(init.body);
        return new Response("", { status: 201 });
      }
      if (url.pathname.endsWith("/tradelab_payment_orders") && method === "PATCH") {
        order = { ...order, ...JSON.parse(init.body) };
        return new Response(JSON.stringify([order]), { status: 200 });
      }
      if (url.pathname.endsWith("/rpc/tradelab_apply_nowpayments_event")) {
        rpcArgs = JSON.parse(init.body);
        return new Response(JSON.stringify({ result: "settled" }), { status: 200 });
      }
      throw new Error(`Unexpected mocked request: ${method} ${url}`);
    };

    const headers = {
      origin: process.env.APP_ORIGIN,
      host: "public.example.test",
      "x-forwarded-proto": "https",
      cookie: "__Host-tradelab_session=test-session"
    };
    const checkoutEvent = (idempotencyKey) => ({
      httpMethod: "POST",
      path: "/api/payments/checkout",
      rawUrl: `${process.env.APP_ORIGIN}/api/payments/checkout`,
      headers,
      body: JSON.stringify({ challengeId: "starter", idempotencyKey })
    });

    const idempotencyKey = "847ef9a5-3490-4f52-9be6-e9ef64513a90";
    const first = await handler(checkoutEvent(idempotencyKey));
    assert.equal(first.statusCode, 201, first.body);
    const firstBody = JSON.parse(first.body);
    assert.equal(firstBody.invoiceUrl, "https://nowpayments.io/payment/?iid=invoice-test-1");
    assert.equal(order.max_daily_loss, 2500);
    assert.equal(order.max_total_loss, 7500);
    assert.equal(order.profit_target, 20);
    assert.equal(order.profit_target_value, 10000);
    assert.equal(order.min_trading_days, 5);
    assert.equal(providerCalls, 1);

    const healthEvent = { httpMethod: "GET", path: "/api/health", rawUrl: `${process.env.APP_ORIGIN}/api/health`, headers: {} };
    const readyHealth = await handler(healthEvent);
    assert.equal(JSON.parse(readyHealth.body).checkoutEnabled, true);

    const retry = await handler(checkoutEvent(idempotencyKey));
    assert.equal(retry.statusCode, 201, retry.body);
    assert.equal(JSON.parse(retry.body).invoiceUrl, firstBody.invoiceUrl);
    assert.equal(providerCalls, 1, "same idempotency key must not create another invoice");
    const crossOrigin = await handler({ ...checkoutEvent("d704d2d6-0a33-4d77-a6b4-3bc3181c9ce5"), headers: { ...headers, origin: "https://evil.example.test" } });
    assert.equal(crossOrigin.statusCode, 403);

    nextChallengeRules = { ...challenge, profit_target_percent: 10 };
    const mismatch = await handler(checkoutEvent("94c1a207-cc09-4bc9-b3c0-99e2c40444e0"));
    assert.equal(mismatch.statusCode, 503);
    assert.match(JSON.parse(mismatch.body).error, /catalogue values do not match/i);
    assert.equal(providerCalls, 1, "mismatched catalogue rules must block invoice creation");
    const mismatchHealth = await handler(healthEvent);
    assert.equal(JSON.parse(mismatchHealth.body).checkoutEnabled, false);
    nextChallengeRules = challenge;

    const webhookPayload = {
      payment_id: 987654321,
      payment_status: "finished",
      price_amount: 500,
      price_currency: "ZAR",
      pay_amount: 0.0123,
      pay_currency: "btc",
      actually_paid: 0.0123,
      order_id: firstBody.orderId,
      invoice_id: "invoice-test-1"
    };
    const signedBody = JSON.stringify(webhookPayload);
    const canonical = JSON.stringify(canonicalNowPaymentsBody(webhookPayload));
    const signature = createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET).update(canonical).digest("hex");
    const webhookEvent = {
      httpMethod: "POST",
      path: "/api/webhooks/nowpayments",
      rawUrl: "https://public.example.test/api/webhooks/nowpayments",
      headers: { "x-nowpayments-sig": signature },
      body: signedBody,
      isBase64Encoded: false
    };
    const webhook = await handler(webhookEvent);
    assert.equal(webhook.statusCode, 200, webhook.body);
    assert.equal(rpcArgs.p_order_id, firstBody.orderId);
    assert.equal(rpcArgs.p_payment_status, "finished");
    assert.equal(rpcArgs.p_price_amount, 500);
    assert.equal(rpcArgs.p_price_currency, "ZAR");
    assert.match(rpcArgs.p_payload_hash, /^[a-f0-9]{64}$/);

    const badSignature = await handler({ ...webhookEvent, headers: { "x-nowpayments-sig": "bad" } });
    assert.equal(badSignature.statusCode, 401);

    process.env.CHECKOUT_ENABLED = "false";
    const disabled = await handler(checkoutEvent("d704d2d6-0a33-4d77-a6b4-3bc3181c9ce5"));
    assert.equal(disabled.statusCode, 503);
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});
