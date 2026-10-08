import { apiRequest } from "/assets/js/api.js";

// The list is illustrative only when the secure API is unavailable. The API returns the full
// active Supabase instrument catalogue; no live market values or keys are embedded here.
const symbolFallbacks = [
  { symbol: "XAUUSD", label: "Gold / US Dollar" },
  { symbol: "EURUSD", label: "Euro / US Dollar" },
  { symbol: "GBPUSD", label: "Pound / US Dollar" },
  { symbol: "USDJPY", label: "US Dollar / Japanese Yen" },
  { symbol: "AUDUSD", label: "Australian Dollar / US Dollar" },
  { symbol: "US100", label: "Nasdaq-100" },
  { symbol: "US30", label: "Dow Jones" },
  { symbol: "GER40", label: "DAX 40" },
  { symbol: "UK100", label: "FTSE 100" },
  { symbol: "XAGUSD", label: "Silver / US Dollar" }
];
const sampleBases = { XAUUSD: 2350, EURUSD: 1.08, GBPUSD: 1.27, USDJPY: 150, AUDUSD: 0.66, US100: 18000, US30: 39000, GER40: 18000, UK100: 7800, XAGUSD: 29 };
let activeSymbol = "";
let activeInterval = "1h";
let currentInstrument = null;
let latestCandles = [];
let tvChart = null;
let tvSeries = null;
let tvLoaderPromise = null;
let allInstruments = [];

const canvas = document.querySelector("#chart-canvas");
const chartStage = document.querySelector("#chart-stage");
const ctx = canvas?.getContext("2d");
const chartPanel = document.querySelector("#chart-panel");
const chartPrompt = document.querySelector("#chart-select-prompt");

function safeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function deterministicSamples(symbol, interval) {
  const base = sampleBases[symbol] ?? 100;
  const seed = [...`${symbol}-${interval}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const rows = [];
  let close = base;
  for (let i = 0; i < 72; i++) {
    const wave = Math.sin((i + seed) * 0.54) * base * 0.0018;
    const drift = Math.cos((i + seed) * 0.16) * base * 0.0006;
    const open = close;
    close = Math.max(0.00001, open + wave + drift);
    const high = Math.max(open, close) + Math.abs(Math.sin(i * 1.2 + seed)) * base * 0.0008;
    const low = Math.min(open, close) - Math.abs(Math.cos(i * 0.9 + seed)) * base * 0.0007;
    rows.push({ time: Date.now() - (71 - i) * 60_000, open, high, low, close });
  }
  return rows;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const rawTime = row.time ?? row.datetime ?? row.timestamp;
    const time = typeof rawTime === "number" ? rawTime * (rawTime > 10_000_000_000 ? 0.001 : 1) : Date.parse(rawTime);
    return { time: Number.isFinite(time) ? time : Date.now(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) };
  }).filter((row) => [row.open, row.high, row.low, row.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
}

function drawFallbackChart(rows = latestCandles) {
  if (!canvas || !ctx || !chartStage || !activeSymbol) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0c0d0e";
  ctx.fillRect(0, 0, width, height);
  const pad = { top: 22, right: 58, bottom: 28, left: 14 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const list = rows.length ? rows.slice(-80) : deterministicSamples(activeSymbol, activeInterval);
  const high = Math.max(...list.map((item) => item.high));
  const low = Math.min(...list.map((item) => item.low));
  const range = high - low || Math.abs(high) * 0.01 || 1;
  const yFor = (value) => pad.top + ((high - value) / range) * plotH;
  const prices = 5;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.fillStyle = "#777780";
  ctx.font = "10px ui-monospace,monospace";
  for (let i = 0; i <= prices; i++) {
    const y = pad.top + (plotH / prices) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    const price = high - (range / prices) * i;
    ctx.fillText(price.toFixed(price < 10 ? 4 : 2), width - pad.right + 7, y + 3);
  }
  const step = plotW / list.length;
  const bodyW = Math.max(2, Math.min(9, step * 0.58));
  list.forEach((item, i) => {
    const x = pad.left + step * i + step / 2;
    const up = item.close >= item.open;
    const color = up ? "#22c55e" : "#fb7185";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yFor(item.high)); ctx.lineTo(x, yFor(item.low)); ctx.stroke();
    const top = yFor(Math.max(item.open, item.close));
    const bottom = yFor(Math.min(item.open, item.close));
    ctx.fillRect(x - bodyW / 2, top, bodyW, Math.max(1.5, bottom - top));
  });
  ctx.strokeStyle = "#29292d";
  ctx.beginPath(); ctx.moveTo(width - pad.right, pad.top); ctx.lineTo(width - pad.right, height - pad.bottom); ctx.stroke();
}

function updateStatus(message, live = false) {
  const status = document.querySelector("#data-status");
  const source = document.querySelector("#chart-source");
  const watermark = document.querySelector("#chart-watermark");
  if (status) status.textContent = message;
  if (status) status.style.color = live ? "#86efac" : "#d4d4d8";
  if (source) source.textContent = live ? "Twelve Data · server-side feed; plan/licence may affect freshness" : "Illustrative sample candles · not live market data";
  if (watermark) watermark.textContent = live ? "TWELVE DATA · SERVER RESPONSE" : "ILLUSTRATIVE SAMPLE · NOT LIVE";
  if (canvas) canvas.setAttribute("aria-label", live ? "Market data chart provided through the secure server adapter" : "Illustrative candlestick chart, not live market data");
}

function openSelectedChart(instrument) {
  currentInstrument = instrument;
  activeSymbol = instrument.symbol;
  chartPanel?.classList.remove("hidden");
  chartPrompt?.classList.add("hidden");
  document.querySelectorAll(".instrument-item").forEach((item) => item.classList.toggle("active", item.dataset.symbol === activeSymbol));
  loadSeries();
  if (window.matchMedia("(max-width: 680px)").matches) {
    window.setTimeout(() => chartPanel.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }
}

function closeSelectedChart() {
  setChartMaximized(false);
  chartPanel?.classList.add("hidden");
  chartPrompt?.classList.remove("hidden");
  updateStatus("Select an instrument");
  if (window.matchMedia("(max-width: 680px)").matches) {
    window.setTimeout(() => document.querySelector(".instrument-list-heading")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }
}

async function loadTradingView() {
  if (window.LightweightCharts) return window.LightweightCharts;
  if (tvLoaderPromise) return tvLoaderPromise;
  tvLoaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/lightweight-charts@5.0.7/dist/lightweight-charts.standalone.production.js";
    script.async = true;
    const timeout = window.setTimeout(() => { script.remove(); reject(new Error("Chart library unavailable")); }, 2200);
    script.onload = () => { window.clearTimeout(timeout); resolve(window.LightweightCharts); };
    script.onerror = () => { window.clearTimeout(timeout); reject(new Error("Chart library unavailable")); };
    document.head.append(script);
  });
  return tvLoaderPromise;
}

async function renderTradingView(rows) {
  try {
    const library = await loadTradingView();
    if (!library?.createChart || !chartStage) return false;
    let host = chartStage.querySelector("#tv-chart-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "tv-chart-host";
      host.style.cssText = "position:absolute;inset:0;display:none";
      chartStage.append(host);
    }
    if (tvChart) tvChart.remove();
    tvChart = library.createChart(host, {
      width: host.clientWidth || chartStage.clientWidth,
      height: host.clientHeight || chartStage.clientHeight,
      layout: { background: { type: library.ColorType?.Solid ?? "solid", color: "#0c0d0e" }, textColor: "#8b8b92" },
      grid: { vertLines: { color: "rgba(255,255,255,.035)" }, horzLines: { color: "rgba(255,255,255,.07)" } },
      rightPriceScale: { borderColor: "#28282b" },
      timeScale: { borderColor: "#28282b", timeVisible: true },
      crosshair: { mode: library.CrosshairMode?.Normal ?? 0 }
    });
    tvSeries = library.CandlestickSeries ? tvChart.addSeries(library.CandlestickSeries, { upColor: "#22c55e", downColor: "#fb7185", borderVisible: false, wickUpColor: "#22c55e", wickDownColor: "#fb7185" }) : tvChart.addCandlestickSeries({ upColor: "#22c55e", downColor: "#fb7185", borderVisible: false, wickUpColor: "#22c55e", wickDownColor: "#fb7185" });
    const data = normalizeRows(rows).map((row) => ({ time: Math.floor(row.time / 1000), open: row.open, high: row.high, low: row.low, close: row.close }));
    if (data.length) tvSeries.setData(data);
    host.style.display = "block";
    canvas.style.display = "none";
    chartStage.classList.remove("has-preview");
    const resize = () => tvChart?.applyOptions({ width: chartStage.clientWidth, height: chartStage.clientHeight });
    window.removeEventListener("resize", drawFallbackChart);
    window.addEventListener("resize", resize);
    return true;
  } catch { return false; }
}

async function loadSeries() {
  if (!activeSymbol || !currentInstrument || !chartPanel || chartPanel.classList.contains("hidden")) return;
  const label = document.querySelector("#current-symbol");
  const name = document.querySelector("#current-name");
  const intervalLabel = document.querySelector("#chart-timeframe-label");
  if (label) label.textContent = activeSymbol;
  if (name) name.textContent = `${currentInstrument.label || currentInstrument.name || "Market"} · view only`;
  if (intervalLabel) intervalLabel.textContent = activeInterval;
  const placeholder = document.querySelector("#chart-placeholder");
  if (placeholder) { placeholder.textContent = "Loading chart…"; placeholder.style.display = "grid"; }
  let live = false;
  try {
    const params = new URLSearchParams({ symbol: activeSymbol, interval: activeInterval });
    const payload = await apiRequest(`/market/series?${params.toString()}`);
    const rows = normalizeRows(payload.values || payload.data || []);
    if (!rows.length) throw new Error("No market data");
    latestCandles = rows;
    live = payload.source === "twelvedata";
  } catch {
    latestCandles = deterministicSamples(activeSymbol, activeInterval);
  }
  if (placeholder) placeholder.style.display = "none";
  updateStatus(live ? "Twelve Data · server feed" : "Preview chart · not live", live);
  const rendered = await renderTradingView(latestCandles);
  if (!rendered) {
    const host = chartStage?.querySelector("#tv-chart-host");
    if (host) host.style.display = "none";
    if (canvas) canvas.style.display = "block";
    chartStage?.classList.add("has-preview");
    drawFallbackChart(latestCandles);
    window.removeEventListener("resize", drawFallbackChart);
    window.addEventListener("resize", drawFallbackChart);
  }
}

function renderWatchlist(rows, source) {
  const host = document.querySelector("#instrument-list");
  if (!host) return;
  allInstruments = rows.map((item) => ({
    symbol: String(item.symbol ?? item.ticker ?? item.code ?? "").trim().toUpperCase(),
    label: String(item.display_name ?? item.name ?? item.label ?? item.symbol ?? "Market").trim()
  })).filter((item) => item.symbol).slice(0, 24);
  host.innerHTML = allInstruments.map((item) => `<button class="instrument-item ${item.symbol === activeSymbol ? "active" : ""}" type="button" data-symbol="${safeText(item.symbol)}" data-label="${safeText(item.label)}" aria-label="View chart for ${safeText(item.symbol)} ${safeText(item.label)}"><span class="instrument-copy"><strong>${safeText(item.symbol)}</strong><small>${safeText(item.label)}</small></span><span class="instrument-open">Chart <span aria-hidden="true">↗</span></span></button>`).join("");
  host.querySelectorAll("[data-symbol]").forEach((button) => button.addEventListener("click", () => openSelectedChart({ symbol: button.dataset.symbol, label: button.dataset.label })));
  const count = document.querySelector("#instrument-count");
  const sourceLabel = document.querySelector("#instrument-source");
  if (count) count.textContent = `(${allInstruments.length})`;
  if (sourceLabel) sourceLabel.textContent = source;
  filterWatchlist();
}

function filterWatchlist() {
  const query = String(document.querySelector("#instrument-search")?.value || "").trim().toLowerCase();
  const items = document.querySelectorAll("#instrument-list .instrument-item");
  let visible = 0;
  items.forEach((item) => {
    const match = !query || `${item.dataset.symbol} ${item.dataset.label}`.toLowerCase().includes(query);
    item.classList.toggle("hidden", !match);
    if (match) visible += 1;
  });
  const count = document.querySelector("#instrument-count");
  if (count) count.textContent = query ? `(${visible} of ${allInstruments.length})` : `(${allInstruments.length})`;
}

async function loadInstruments() {
  let rows = symbolFallbacks;
  let source = "Example list · secure catalogue not connected";
  try {
    const payload = await apiRequest("/instruments");
    if (Array.isArray(payload) && payload.length) {
      rows = payload;
      source = `Loaded ${payload.length} instruments from the secure catalogue`;
    }
  } catch { /* Show the clearly labelled sample list, never query Supabase in the browser. */ }
  renderWatchlist(rows, source);
}

async function loadSession() {
  const link = document.querySelector("#auth-link");
  const logout = document.querySelector("#terminal-logout");
  if (!link) return;
  try {
    const payload = await apiRequest("/auth/me");
    link.textContent = `My accounts · ${payload.user?.firstName || "Account"}`;
    link.href = "/accounts.html";
    logout?.classList.remove("hidden");
  } catch {
    link.textContent = "Sign in";
    link.href = "/login.html";
  }
}

function setChartMaximized(maximized) {
  if (!chartPanel || chartPanel.classList.contains("hidden")) return;
  chartPanel.classList.toggle("chart-maximized", maximized);
  document.body.classList.toggle("chart-maximized-open", maximized);
  const button = document.querySelector("#maximize-chart");
  if (button) {
    button.setAttribute("aria-pressed", String(maximized));
    button.setAttribute("aria-label", maximized ? "Restore chart" : "Maximize chart");
    button.title = maximized ? "Restore chart" : "Maximize chart";
    button.textContent = maximized ? "↙" : "⛶";
  }
  requestAnimationFrame(() => {
    if (tvChart && chartStage) tvChart.applyOptions({ width: chartStage.clientWidth, height: chartStage.clientHeight });
    else drawFallbackChart();
  });
}

for (const button of document.querySelectorAll("[data-interval]")) {
  button.addEventListener("click", () => {
    activeInterval = button.dataset.interval;
    document.querySelectorAll("[data-interval]").forEach((item) => item.classList.toggle("active", item === button));
    loadSeries();
  });
}

document.querySelector("#maximize-chart")?.addEventListener("click", () => {
  setChartMaximized(!chartPanel?.classList.contains("chart-maximized"));
});
document.querySelector("#back-to-instruments")?.addEventListener("click", closeSelectedChart);
document.querySelector("#instrument-search")?.addEventListener("input", filterWatchlist);
document.querySelector("#terminal-logout")?.addEventListener("click", async () => {
  try { await apiRequest("/auth/logout", { method: "POST", body: {} }); } catch { /* Cookie expires server-side. */ }
  window.location.assign("/login.html");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && chartPanel?.classList.contains("chart-maximized")) setChartMaximized(false);
});

loadInstruments();
loadSession();
