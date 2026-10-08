import { apiRequest } from "/assets/js/api.js";

const feesByBalance = { 50000: 500, 100000: 1000, 200000: 2500 };
let checkoutEnabled = false;
const fallbackChallenges = [
  { id: "preview-50000", name: "R50,000 Challenge", balance: 50000, feeZar: 500 },
  { id: "preview-100000", name: "R100,000 Challenge", balance: 100000, feeZar: 1000 },
  { id: "preview-200000", name: "R200,000 Challenge", balance: 200000, feeZar: 2500 }
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function money(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return `R${Number(value).toLocaleString("en-ZA", { maximumFractionDigits: 2 })}`;
}

function showMessage(text, tone = "normal") {
  const el = document.querySelector("#accounts-message");
  if (!el) return;
  el.textContent = text;
  el.style.color = tone === "warning" ? "#f0d98c" : tone === "success" ? "#86efac" : "#a1a1aa";
}

function renderCatalogue(rows) {
  const host = document.querySelector("#challenge-catalogue");
  if (!host) return;
  const data = Array.isArray(rows) && rows.length ? rows : fallbackChallenges;
  host.innerHTML = data.map((row) => {
    const balance = Number(row.balance ?? row.virtual_balance ?? 0);
    const name = String(row.name ?? row.title ?? `R${balance.toLocaleString("en-ZA")} Challenge`);
    const feeZar = Number(row.feeZar ?? row.fee_zar ?? feesByBalance[balance] ?? 0);
    const challengeId = String(row.id ?? "");
    const canCheckout = checkoutEnabled && challengeId && !challengeId.startsWith("preview-");
    return `<article class="challenge-card">
      <div class="challenge-name">${escapeHtml(name)}</div>
      <div class="challenge-price">${feeZar ? `${money(feeZar)} access fee` : "Fee pending"}</div>
      <div class="virtual">${money(balance)} virtual starting balance</div>
      <div class="rule-list">
        <div class="rule-row"><span>Profit target</span><strong>20%</strong></div>
        <div class="rule-row"><span>Daily loss limit</span><strong>5% static</strong></div>
        <div class="rule-row"><span>Overall loss limit</span><strong>15% static</strong></div>
        <div class="rule-row"><span>Minimum trading days</span><strong>5</strong></div>
      </div>
      <button class="btn ${canCheckout ? "btn-primary" : "checkout-disabled"}" type="button" data-checkout-challenge="${escapeHtml(challengeId)}" ${canCheckout ? "" : "disabled aria-disabled=\"true\""}>${canCheckout ? "Start hosted checkout" : "Checkout disabled"}</button>
      <div class="draft-caption">Daily reset 00:00 Africa/Johannesburg · open P/L counts</div>
    </article>`;
  }).join("");
}

function renderAccounts(accounts) {
  const section = document.querySelector("#owned-section");
  const empty = document.querySelector("#empty-section");
  const host = document.querySelector("#owned-accounts");
  const count = document.querySelector("#owned-count");
  if (!Array.isArray(accounts) || accounts.length === 0) {
    section?.classList.add("hidden");
    empty?.classList.remove("hidden");
    if (count) count.textContent = "0 accounts";
    return;
  }
  empty?.classList.add("hidden");
  section?.classList.remove("hidden");
  if (count) count.textContent = `${accounts.length} account${accounts.length === 1 ? "" : "s"}`;
  if (!host) return;
  host.innerHTML = accounts.map((account) => {
    const status = String(account.status || "unknown").replace(/[_-]+/g, " ");
    const started = account.createdAt ? new Date(account.createdAt) : null;
    const created = started && Number.isFinite(started.getTime()) ? started.toLocaleDateString() : "—";
    return `<article class="panel owned-account-card">
      <div class="owned-account-top"><div><div class="panel-label">Challenge account</div><h3>${escapeHtml(account.challengeName || "Trading challenge")}</h3></div><span class="status-pill">${escapeHtml(status)}</span></div>
      <div class="owned-account-stats">
        <div><span>Virtual starting balance</span><strong>${money(account.startingBalance)}</strong></div>
        <div><span>Current equity</span><strong>${money(account.equity)}</strong></div>
        <div><span>Created</span><strong>${escapeHtml(created)}</strong></div>
      </div>
      <a class="btn btn-small" href="/app.html">Browse instruments</a>
    </article>`;
  }).join("");
}

async function loadDashboard() {
  try {
    const session = await apiRequest("/auth/me");
    const userLabel = document.querySelector("#account-user");
    if (userLabel) userLabel.textContent = session.user?.firstName ? `Hi, ${session.user.firstName}` : session.user?.email || "Signed in";
  } catch (error) {
    if (error.status === 401) {
      window.location.assign("/login.html");
      return;
    }
    showMessage("Secure account service is not available in this preview. Sign in through the configured server API to view accounts.", "warning");
    renderCatalogue(fallbackChallenges);
    return;
  }

  let accounts = [];
  try {
    accounts = await apiRequest("/account/challenges");
    showMessage("Your challenge records are loaded from the secure server API.", "success");
    renderAccounts(Array.isArray(accounts) ? accounts : []);
  } catch (error) {
    if (error.status === 401) {
      window.location.assign("/login.html");
      return;
    }
    showMessage(error.message || "Could not load challenge accounts.", "warning");
    document.querySelector("#owned-section")?.classList.add("hidden");
    const empty = document.querySelector("#empty-section");
    empty?.classList.remove("hidden");
    const heading = document.querySelector("#empty-heading");
    const copy = document.querySelector("#empty-copy");
    if (heading) heading.textContent = "Accounts could not be loaded";
    if (copy) copy.textContent = "The secure account API is unavailable. No account status is being inferred; try again after reconnecting.";
    const count = document.querySelector("#owned-count");
    if (count) count.textContent = "Unavailable";
  }

  try {
    const health = await apiRequest("/health");
    checkoutEnabled = health.checkoutEnabled === true;
  } catch { checkoutEnabled = false; }
  const checkoutStatus = document.querySelector("#catalogue-status");
  const checkoutCopy = document.querySelector("#catalogue-copy");
  if (checkoutStatus) checkoutStatus.textContent = checkoutEnabled ? "Hosted checkout available" : "Checkout disabled";
  if (checkoutCopy) checkoutCopy.textContent = checkoutEnabled
    ? "Approved fees are shown in ZAR. Payment is hosted by the provider; a challenge account is created only after the server verifies settlement."
    : "Approved fees are displayed. Checkout stays disabled until server-side order settlement, provider setup and legal review are complete.";

  try {
    const challenges = await apiRequest("/challenges");
    renderCatalogue(challenges);
  } catch {
    renderCatalogue(fallbackChallenges);
  }
  await showPaymentReturnStatus();
}

async function showPaymentReturnStatus() {
  const params = new URLSearchParams(window.location.search);
  const paymentState = params.get("payment");
  const orderId = params.get("order");
  if (paymentState === "cancel") {
    showMessage("Checkout was cancelled. No challenge account is created unless settlement is confirmed.", "warning");
    return;
  }
  if (paymentState !== "return" || !orderId) return;
  try {
    const order = await apiRequest(`/payments/orders/${encodeURIComponent(orderId)}`);
    if (order.status === "settled") showMessage("Payment verified. Your challenge account is active.", "success");
    else showMessage(`Payment status: ${String(order.providerStatus || order.status).replace(/[_-]+/g, " ")}. Your account will activate only after verified settlement.`, "normal");
  } catch (error) {
    showMessage(error.message || "We could not retrieve this payment status. Do not pay again; contact support with your order reference.", "warning");
  }
}

document.querySelector("#challenge-catalogue")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-checkout-challenge]");
  if (!button || button.disabled) return;
  const challengeId = button.dataset.checkoutChallenge;
  if (!challengeId || challengeId.startsWith("preview-")) return;
  if (!button.dataset.idempotencyKey) {
    if (!globalThis.crypto?.randomUUID) {
      showMessage("This browser cannot create a secure checkout request. Update your browser and try again.", "warning");
      return;
    }
    button.dataset.idempotencyKey = globalThis.crypto.randomUUID();
  }
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = "Creating secure invoice…";
  showMessage("Creating a hosted invoice securely. Do not refresh or pay twice.");
  try {
    const result = await apiRequest("/payments/checkout", {
      method: "POST",
      body: { challengeId, idempotencyKey: button.dataset.idempotencyKey }
    });
    const invoiceUrl = new URL(result.invoiceUrl);
    if (invoiceUrl.protocol !== "https:" || !/(^|\.)nowpayments\.io$/i.test(invoiceUrl.hostname)) throw new Error("The payment provider returned an invalid secure invoice link.");
    showMessage("Invoice ready. Redirecting to the payment provider…", "success");
    window.location.assign(invoiceUrl.toString());
  } catch (error) {
    showMessage(error.message || "Checkout could not be started. No challenge account has been created.", "warning");
    button.disabled = false;
    button.textContent = originalLabel;
  }
});

document.querySelector("#accounts-logout")?.addEventListener("click", async () => {
  try { await apiRequest("/auth/logout", { method: "POST", body: {} }); } catch { /* Session cookie expires server-side. */ }
  window.location.assign("/login.html");
});

loadDashboard();
