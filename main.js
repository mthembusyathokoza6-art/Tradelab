import { apiRequest } from "/assets/js/api.js";

const ruleDefaults = {
  profitTargetPercent: 20,
  dailyLossPercent: 5,
  maxLossPercent: 15,
  minTradingDays: 5
};
const approvedFeesByBalance = { 50000: 500, 100000: 1000, 200000: 2500 };
const fallbackChallenges = [
  { id: "preview-50000", name: "Foundation", balance: 50000, feeZar: 500 },
  { id: "preview-100000", name: "Growth", balance: 100000, feeZar: 1000 },
  { id: "preview-200000", name: "Performance", balance: 200000, feeZar: 2500 }
];
const fallbackInstruments = [
  { symbol: "XAUUSD", label: "Gold / US Dollar" },
  { symbol: "EURUSD", label: "Euro / US Dollar" },
  { symbol: "GBPUSD", label: "Pound / US Dollar" },
  { symbol: "USDJPY", label: "US Dollar / Japanese Yen" },
  { symbol: "US100", label: "Nasdaq-100" },
  { symbol: "US30", label: "Dow Jones" }
];

function formatRand(value) {
  return `R${Number(value || 0).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`;
}

function normalizeChallenge(row, index) {
  const balance = Number(row.balance ?? row.virtual_balance ?? row.starting_balance ?? row.account_size ?? fallbackChallenges[index]?.balance ?? 0);
  return {
    id: String(row.id ?? fallbackChallenges[index]?.id ?? `challenge-${index + 1}`),
    name: String(row.name ?? row.title ?? fallbackChallenges[index]?.name ?? `Challenge ${index + 1}`),
    balance,
    feeZar: Number(row.feeZar ?? row.fee_zar ?? approvedFeesByBalance[balance] ?? 0)
  };
}

function renderChallenges(items, sourceLabel) {
  const host = document.querySelector("#challenge-list");
  if (!host) return;
  const challenges = items.map(normalizeChallenge);
  host.innerHTML = challenges.map((challenge, index) => `
    <article class="challenge-card ${index === 1 ? "featured" : ""}">
      <div class="challenge-name">${escapeHtml(challenge.name)}</div>
      <div class="challenge-price">${challenge.feeZar ? `${formatRand(challenge.feeZar)} access fee` : "Fee pending"}</div>
      <div class="virtual">${formatRand(challenge.balance)} virtual starting balance</div>
      <div class="rule-list">
        <div class="rule-row"><span>Profit target</span><strong>${ruleDefaults.profitTargetPercent}%</strong></div>
        <div class="rule-row"><span>Daily loss limit</span><strong>${ruleDefaults.dailyLossPercent}% static</strong></div>
        <div class="rule-row"><span>Overall loss limit</span><strong>${ruleDefaults.maxLossPercent}% static</strong></div>
        <div class="rule-row"><span>Minimum trading days</span><strong>${ruleDefaults.minTradingDays}</strong></div>
        <div class="rule-row"><span>Potential reward share</span><strong>80%*</strong></div>
      </div>
      <button class="btn" type="button" disabled aria-disabled="true">Purchases not enabled</button>
      <div class="draft-caption">${sourceLabel} · fees approved · daily reset 00:00 Johannesburg · open P/L counts. *Subject to review; not guaranteed.</div>
    </article>`).join("");
}

function renderMarkets(rows, sourceLabel) {
  const host = document.querySelector("#market-list");
  if (!host) return;
  const markets = rows.map((item) => ({
    symbol: String(item.symbol ?? item.ticker ?? item.code ?? "").toUpperCase(),
    label: String(item.display_name ?? item.name ?? item.label ?? "")
  })).filter((item) => item.symbol).slice(0, 20);
  host.innerHTML = markets.map((market) => `<span class="market-chip" title="${escapeHtml(market.label)}">${escapeHtml(market.symbol)}</span>`).join("");
  const note = document.querySelector("#markets-note");
  if (note) note.textContent = sourceLabel;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function initAuthNav() {
  const accountLink = document.querySelector("#auth-nav-link");
  const registerLink = document.querySelector("#register-nav-link");
  if (!accountLink) return;
  try {
    const session = await apiRequest("/auth/me");
    accountLink.textContent = "My challenge accounts";
    accountLink.href = "/accounts.html";
    if (registerLink) registerLink.classList.add("hidden");
  } catch { /* Keep sign-in and registration links for signed-out visitors. */ }
}

async function initPublicSettings() {
  const link = document.querySelector("#contact-link");
  const placeholder = document.querySelector("#contact-placeholder");
  if (!link || !placeholder) return;
  try {
    const settings = await apiRequest("/settings/public");
    const email = String(settings.inquiry_email || "").trim();
    const phone = String(settings.inquiry_phone || "").trim();
    const emailOk = email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const phoneValue = phone.replace(/[^0-9+]/g, "");
    if (emailOk) {
      link.href = `mailto:${encodeURIComponent(email).replace(/%40/gi, "@")}`;
      link.textContent = phoneValue ? `Contact · ${email} · ${phone}` : `Contact · ${email}`;
      link.title = String(settings.support_hours || "");
    } else if (phoneValue) {
      link.href = `tel:${phoneValue}`;
      link.textContent = `Call · ${phone}`;
    } else return;
    link.classList.remove("hidden");
    placeholder.classList.add("hidden");
  } catch { /* No public contact values are configured yet. */ }
}

async function initHome() {
  const challenges = document.querySelector("#challenge-list");
  if (!challenges) return;
  let challengeSource = "illustrative preview";
  let instrumentSource = "illustrative preview markets";
  let instruments = fallbackInstruments;
  try {
    const rows = await apiRequest("/challenges");
    if (Array.isArray(rows) && rows.length) {
      renderChallenges(rows, "Supabase catalogue");
      challengeSource = "Supabase catalogue";
    } else {
      renderChallenges(fallbackChallenges, "illustrative preview");
    }
  } catch {
    renderChallenges(fallbackChallenges, "illustrative preview");
  }
  try {
    const rows = await apiRequest("/instruments");
    if (Array.isArray(rows) && rows.length) {
      instruments = rows;
      instrumentSource = "Supabase instruments";
    }
  } catch { /* Keep the non-live preview list. */ }
  renderMarkets(instruments, instrumentSource);
  const marketNote = document.querySelector("#markets-source");
  if (marketNote) marketNote.textContent = instrumentSource;
  const status = document.querySelector("#catalogue-source");
  if (status) status.textContent = challengeSource;
}

for (const button of document.querySelectorAll("#pwa-install-btn, #download-app-btn")) {
  button.addEventListener("click", () => window.installTradeLab?.());
}

const menuToggle = document.querySelector("#menu-toggle");
menuToggle?.addEventListener("click", () => {
  const nav = document.querySelector(".nav-links");
  if (!nav) return;
  const opened = nav.dataset.open === "true";
  nav.dataset.open = String(!opened);
  nav.style.display = opened ? "none" : "flex";
  nav.style.position = opened ? "" : "absolute";
  nav.style.top = opened ? "" : "63px";
  nav.style.left = opened ? "" : "14px";
  nav.style.right = opened ? "" : "14px";
  nav.style.padding = opened ? "" : "18px";
  nav.style.flexDirection = opened ? "" : "column";
  nav.style.alignItems = opened ? "" : "stretch";
  nav.style.background = opened ? "" : "#111113";
  nav.style.border = opened ? "" : "1px solid #29292d";
  nav.style.borderRadius = opened ? "" : "14px";
});

initHome();
initPublicSettings();
initAuthNav();
