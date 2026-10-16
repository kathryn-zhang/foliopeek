/* FolioPeek — private portfolio tracker.
   All state lives in localStorage; quotes come from the local proxy at /api/quotes.
   (Storage keys keep the original "ledger.*" prefix so existing data survives
   the rename.) */

"use strict";

// ───────────────────────── State ─────────────────────────

const STORE_KEY = "ledger.v1";

const INDEXES = [
  { sym: "^GSPC", label: "S&P 500" },
  { sym: "^IXIC", label: "NASDAQ" },
  { sym: "^DJI",  label: "Dow Jones" },
  { sym: "^VIX",  label: "VIX", note: "volatility — up means fear", neutral: true },
  { sym: "^SOX",  label: "SOX", note: "semiconductors" },
];

let state = loadState();
let quotes = {};            // symbol → quote object from the server
let sortKey = "value";
let sortDir = -1;           // -1 desc, 1 asc
let refreshTimer = null;

// Brokers write class shares with a dot (E*Trade: BRK.B) or a space
// (Vanguard: BRK B); Yahoo wants a dash (BRK-B). Convert a single trailing
// class letter after a dot or space.
function normalizeSymbol(sym) {
  return sym.trim().toUpperCase().replace(/^([A-Z]+)[. ]([A-Z])$/, "$1-$2");
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw && Array.isArray(raw.portfolio) && Array.isArray(raw.watchlist)) {
      // Heal symbols saved before dot→dash normalization existed, and tag
      // rows saved before imports were source-aware.
      raw.portfolio.forEach((p) => { p.sym = normalizeSymbol(p.sym); p.src = p.src || "manual"; });
      raw.watchlist = raw.watchlist.map(normalizeSymbol);
      return raw;
    }
  } catch { /* corrupted storage falls through to fresh state */ }
  return { portfolio: [], watchlist: [] };
}

function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  scheduleBackup();
}

// One total-value snapshot per calendar day (latest refresh of the day wins),
// kept in localStorage and mirrored into the server-side backup.
let valueHistory = [];
try { valueHistory = JSON.parse(localStorage.getItem("ledger.history.v1")) || []; } catch { /* fresh */ }

function snapshotHistory() {
  const { rows, total } = portfolioRows();
  if (!total) return;
  const cats = {};
  for (const r of rows) {
    if (r.value == null) continue;
    const label = (DIST_CATS[quotes[r.sym]?.quoteType] || DIST_OTHER).label;
    cats[label] = (cats[label] || 0) + r.value;
  }
  // Shares per source and the day's prices, so later snapshots can be diffed
  // to tell new money (share changes) apart from market growth (price changes).
  const pos = {};
  for (const p of state.portfolio) {
    const src = (pos[p.src] = pos[p.src] || {});
    src[p.sym] = (src[p.sym] || 0) + p.shares;
  }
  const px = {};
  for (const r of rows) if (r.price != null) px[r.sym] = r.price;
  const d = new Date().toISOString().slice(0, 10);
  const entry = { d, total: Math.round(total * 100) / 100, cats, pos, px };
  const i = valueHistory.findIndex((h) => h.d === d);
  if (i >= 0) valueHistory[i] = entry; else valueHistory.push(entry);
  localStorage.setItem("ledger.history.v1", JSON.stringify(valueHistory));
  scheduleBackup();
}

// Mirror the full state to the local server, debounced. localStorage can be
// wiped by clearing browser data; the file on disk survives.
let backupTimer = null;
function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    fetch("/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ savedAt: new Date().toISOString(), ...state, history: valueHistory }),
    }).catch(() => { /* server offline; next change retries */ });
  }, 1500);
}

async function maybeRestoreBackup() {
  if (state.portfolio.length || state.watchlist.length) return;
  try {
    const res = await fetch("/api/backup");
    if (!res.ok) return;
    const b = await res.json();
    if (!b.portfolio?.length && !b.watchlist?.length) return;
    const when = b.savedAt ? new Date(b.savedAt).toLocaleString() : "an earlier session";
    if (!confirm(`This browser has no FolioPeek data, but a backup from ${when} exists `
      + `(${(b.portfolio || []).length} holdings). Restore it?`)) return;
    state = { portfolio: b.portfolio || [], watchlist: b.watchlist || [] };
    state.portfolio.forEach((p) => { p.sym = normalizeSymbol(p.sym); p.src = p.src || "manual"; });
    if (Array.isArray(b.history) && b.history.length) {
      valueHistory = b.history;
      localStorage.setItem("ledger.history.v1", JSON.stringify(valueHistory));
    }
    saveState();
    renderAll();
    refresh();
  } catch { /* no server or malformed backup — nothing to restore */ }
}

// ───────────────────────── Formatting ─────────────────────────

const fmtUSD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmtUSD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const fmtShares = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

const money = (v) => (v == null || Number.isNaN(v) ? "—" : fmtUSD.format(v));
const moneyBig = (v) => (v == null || Number.isNaN(v) ? "—" : (Math.abs(v) >= 10000 ? fmtUSD0 : fmtUSD).format(v));
const pct = (v, signed = true) =>
  v == null || Number.isNaN(v) ? "—" : `${signed && v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const dirClass = (v) => (v == null ? "flat" : v > 0 ? "up" : v < 0 ? "down" : "flat");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ───────────────────────── Quotes ─────────────────────────

function allSymbols() {
  const set = new Set(INDEXES.map((i) => i.sym));
  state.portfolio.forEach((p) => set.add(p.sym));
  state.watchlist.forEach((s) => set.add(s));
  return [...set];
}

async function fetchQuotes(symbols) {
  // The server caps one request at 60 symbols — fetch in parallel batches
  // so large portfolios aren't silently truncated.
  const BATCH = 40;
  const batches = [];
  for (let i = 0; i < symbols.length; i += BATCH) batches.push(symbols.slice(i, i + BATCH));
  // One failed batch shouldn't discard the others — take what succeeded and
  // only fail the refresh when every batch did.
  const settled = await Promise.allSettled(batches.map(async (batch) => {
    const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(batch.join(","))}`);
    if (!res.ok) throw new Error(`quote server returned ${res.status}`);
    const data = await res.json();
    return data.quotes || [];
  }));
  const ok = settled.filter((s) => s.status === "fulfilled");
  if (!ok.length && settled.length) throw settled[0].reason;
  return ok.flatMap((s) => s.value);
}

let refreshing = false; // manual click + timer + visibilitychange can overlap
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spinning");
  try {
    const list = await fetchQuotes(allSymbols());
    for (const q of list) if (!q.error) quotes[q.symbol] = q;
    renderAll();
    setStatus();
    snapshotHistory();
  } catch (err) {
    document.getElementById("lastUpdated").textContent = `quotes unavailable (${err.message})`;
  } finally {
    refreshing = false;
    btn.classList.remove("spinning");
  }
}

function setStatus() {
  const t = new Date();
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // Newest quote timestamp on the page — when closed, prices are older than the fetch.
  let newest = 0;
  for (const q of Object.values(quotes)) if (q.marketTime) newest = Math.max(newest, q.marketTime);
  let asOf = "";
  if (newest) {
    const d = new Date(newest * 1000);
    const day = d.toDateString() === t.toDateString()
      ? "" : d.toLocaleDateString([], { weekday: "short" }) + " ";
    asOf = `prices as of ${day}${fmtTime(d)} · `;
  }
  const el = document.getElementById("lastUpdated");
  el.textContent = `${asOf}checked ${fmtTime(t)}`;
  el.title = "“As of” is the quote's own timestamp from Yahoo; “checked” is when this page last fetched it.";
  const ref = quotes["^GSPC"];
  const dot = document.getElementById("marketDot");
  const label = document.getElementById("marketState");
  if (ref) {
    dot.className = `market-dot ${ref.marketOpen ? "open" : "closed"}`;
    label.textContent = ref.marketOpen ? "Market open" : "Market closed";
  }
}

// ───────────────────────── Index strip ─────────────────────────

function renderIndexes() {
  const strip = document.getElementById("indexStrip");
  strip.innerHTML = INDEXES.map((ix) => {
    const q = quotes[ix.sym];
    const price = q?.price != null ? fmtNum.format(q.price) : "—";
    const cls = ix.neutral ? "flat" : dirClass(q?.changePct);
    const arrow = q?.changePct == null ? "" : q.changePct >= 0 ? "▲ " : "▼ ";
    return `
      <div class="index-card">
        <div class="index-label">${esc(ix.label)} <span class="index-sym">${esc(ix.sym)}</span></div>
        <div class="index-price">${price}</div>
        <div class="index-change ${cls}">${arrow}${q ? `${pct(q.changePct)}` : "…"}</div>
        ${ix.note ? `<div class="index-foot">${esc(ix.note)}</div>` : ""}
      </div>`;
  }).join("");
}

// ───────────────────────── Portfolio ─────────────────────────

function portfolioRows() {
  // One position may exist in several sources (Vanguard + E*Trade holding the
  // same ticker): display one row per symbol with summed shares and a
  // share-weighted average cost over the lots that have one.
  const groups = new Map();
  for (const p of state.portfolio) {
    const g = groups.get(p.sym) ||
      { sym: p.sym, entries: [], shares: 0, costedShares: 0, totalCost: 0 };
    g.entries.push(p);
    g.shares += p.shares;
    if (p.cost != null) { g.costedShares += p.shares; g.totalCost += p.cost * p.shares; }
    groups.set(p.sym, g);
  }
  const rows = [...groups.values()].map((g) => {
    const q = quotes[g.sym] || {};
    const cost = g.costedShares > 0 ? g.totalCost / g.costedShares : null;
    const value = q.price != null ? q.price * g.shares : null;
    const gain = q.price != null && cost != null ? (q.price - cost) * g.costedShares : null;
    const gainPct = q.price != null && cost ? ((q.price - cost) / cost) * 100 : null;
    // Today's dollar move: per-share change since the prior close × shares held.
    const dayGain = q.change != null ? q.change * g.shares : null;
    return {
      sym: g.sym, shares: g.shares, cost, costedShares: g.costedShares,
      name: q.name || "", price: q.price, changePct: q.changePct,
      value, dayGain, gain, gainPct, symbol: g.sym,
      sources: g.entries.length,
      sourceLabel: [...new Set(g.entries.map((e) => e.src))].sort().join(" + "),
      breakdown: g.entries.map((e) => `${e.src}: ${fmtShares.format(e.shares)} sh`).join(" · "),
    };
  });
  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  rows.forEach((r) => { r.weight = total > 0 && r.value != null ? (r.value / total) * 100 : null; });
  return { rows, total };
}

function renderPortfolio() {
  const { rows, total } = portfolioRows();
  const body = document.getElementById("portfolioBody");
  const foot = document.getElementById("portfolioFoot");
  const table = document.getElementById("portfolioTable");
  const empty = document.getElementById("portfolioEmpty");

  table.style.display = rows.length ? "" : "none";
  empty.hidden = rows.length > 0;

  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * sortDir;
  });

  body.innerHTML = rows.map((r) => {
    const single = r.sources === 1;
    const editAttrs = (field, label) => single
      ? `class="editable" data-edit="${field}" title="Click to edit ${label}"`
      : `title="${esc(r.breakdown)} — re-import a source to change it"`;
    return `
    <tr data-sym="${esc(r.sym)}">
      <td class="cell-sym">${esc(r.sym)}</td>
      <td class="cell-name" title="${esc(r.name)}">${esc(r.name) || "<span class='cell-muted'>—</span>"}</td>
      <td class="cell-src" title="${esc(r.breakdown)}">${esc(r.sourceLabel)}</td>
      <td class="num cell-num">${money(r.price)}</td>
      <td class="num"><span class="chip ${dirClass(r.changePct)}">${pct(r.changePct)}</span></td>
      <td class="num cell-num ${dirClass(r.dayGain)}">${r.dayGain == null
        ? "<span class='cell-muted'>—</span>"
        : `${r.dayGain >= 0 ? "+" : "−"}${moneyBig(Math.abs(r.dayGain))}`}</td>
      <td class="num cell-num"><span ${editAttrs("shares", "shares")}>${fmtShares.format(r.shares)}</span></td>
      <td class="num cell-num">${single
        ? `<span class="editable ${r.cost == null ? "cell-muted" : ""}" data-edit="cost" title="Click to edit average cost">${r.cost == null ? "add" : money(r.cost)}</span>`
        : `<span class="${r.cost == null ? "cell-muted" : ""}" title="${esc(r.breakdown)}">${r.cost == null ? "—" : money(r.cost)}</span>`}</td>
      <td class="num cell-num">${moneyBig(r.value)}</td>
      <td class="num cell-num gain-cell ${dirClass(r.gain)}">
        ${r.gain == null ? "<span class='cell-muted'>—</span>"
          : `${pct(r.gainPct)}<span class="gain-abs">${r.gain >= 0 ? "+" : "−"}${moneyBig(Math.abs(r.gain))}</span>`}
      </td>
      <td class="num cell-num">${r.weight == null ? "—" : r.weight.toFixed(1) + "%"}</td>
      <td class="num"><button class="row-act" data-act="remove" title="Remove ${esc(r.sym)}">✕</button></td>
    </tr>`;
  }).join("");

  // Totals row — gain only over shares that have a cost basis
  const totalCost = rows.reduce((s, r) => s + (r.cost != null ? r.cost * r.costedShares : 0), 0);
  const costedValue = rows.reduce((s, r) => s + (r.cost != null && r.price != null ? r.price * r.costedShares : 0), 0);
  const totalGain = costedValue && totalCost ? costedValue - totalCost : null;
  const totalGainPct = totalCost ? (totalGain / totalCost) * 100 : null;
  const dayChange = rows.reduce((s, r) => s + (r.dayGain || 0), 0);

  foot.innerHTML = rows.length ? `
    <tr>
      <td colspan="3" class="foot-label">Total ${totalCost ? "(gain on rows with cost)" : ""}</td>
      <td colspan="2"></td>
      <td class="num ${dirClass(dayChange)}">${dayChange >= 0 ? "+" : "−"}${moneyBig(Math.abs(dayChange))}</td>
      <td colspan="2"></td>
      <td class="num">${moneyBig(total)}</td>
      <td class="num ${dirClass(totalGain)}">${totalGain == null ? "—" : pct(totalGainPct)}</td>
      <td class="num">100%</td>
      <td></td>
    </tr>` : "";

  // Masthead total
  document.getElementById("totalValue").textContent = total ? moneyBig(total) : "—";
  const tc = document.getElementById("totalChange");
  tc.textContent = total ? `${dayChange >= 0 ? "▲" : "▼"} ${moneyBig(Math.abs(dayChange))} today` : "";
  tc.className = `total-change ${dirClass(dayChange)}`;

  // sort indicators
  document.querySelectorAll("#portfolioTable th.sortable").forEach((th) => {
    th.classList.toggle("sorted-asc", th.dataset.sort === sortKey && sortDir === 1);
    th.classList.toggle("sorted-desc", th.dataset.sort === sortKey && sortDir === -1);
  });

  renderMovers(rows);
}

// Today's biggest movers in the portfolio, ranked by day % change with the
// dollar impact (change × shares held) alongside. Each symbol appears once:
// with fewer than 10 priced holdings the two lists split the field between
// them, and under 4 there's nothing meaningful to rank.
function renderMovers(rows) {
  const el = document.getElementById("moversStrip");
  const priced = rows.filter((r) => r.changePct != null)
    .sort((a, b) => b.changePct - a.changePct);
  if (priced.length < 4) { el.hidden = true; el.innerHTML = ""; return; }
  const n = Math.min(5, Math.floor(priced.length / 2));
  const top = priced.slice(0, n);
  const bottom = priced.slice(-n).reverse(); // worst first
  const item = (r) => `
    <button class="mover" data-sym="${esc(r.sym)}" title="${esc(r.name)} — jump to row">
      <span class="mover-sym">${esc(r.sym)}</span>
      <span class="mover-pct ${dirClass(r.changePct)}">${pct(r.changePct)}</span>
      <span class="mover-abs">${r.dayGain == null ? ""
        : `${r.dayGain >= 0 ? "+" : "−"}${moneyBig(Math.abs(r.dayGain))}`}</span>
    </button>`;
  el.hidden = false;
  el.innerHTML = `
    <div class="movers-group">
      <span class="movers-label up">▲ Top today</span>${top.map(item).join("")}
    </div>
    <div class="movers-group">
      <span class="movers-label down">▼ Bottom today</span>${bottom.map(item).join("")}
    </div>`;
}

// inline editing of shares / avg cost (single-source positions only;
// multi-source rows are owned by their imports)
function startCellEdit(span, sym, field) {
  const entries = state.portfolio.filter((p) => p.sym === sym);
  if (entries.length !== 1) return;
  const holding = entries[0];
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.min = "0";
  input.className = "cell-input";
  input.value = holding[field === "cost" ? "cost" : "shares"] ?? "";
  span.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const v = parseFloat(input.value);
    let changed = false;
    if (field === "shares") {
      if (v > 0 && v !== holding.shares) { holding.shares = v; changed = true; }
    } else {
      const cost = v > 0 ? v : null; // clearing the field removes cost basis
      if (cost !== holding.cost) { holding.cost = cost; changed = true; }
    }
    // Hand-edits to an imported row are placeholders until that source's next
    // import; remember them so a stale re-import can't discard one silently.
    if (changed && holding.src !== "manual") holding.editedAt = Date.now();
    saveState();
    renderPortfolio();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.removeEventListener("blur", commit); renderPortfolio(); }
  });
}

// ───────────────────────── Watchlist ─────────────────────────

function renderWatchlist() {
  const body = document.getElementById("watchBody");
  const table = document.getElementById("watchTable");
  const empty = document.getElementById("watchEmpty");
  table.style.display = state.watchlist.length ? "" : "none";
  empty.hidden = state.watchlist.length > 0;

  body.innerHTML = state.watchlist.map((sym) => {
    const q = quotes[sym] || {};
    let rangeHtml = "<span class='cell-muted'>—</span>";
    if (q.price != null && q.fiftyTwoWeekLow != null && q.fiftyTwoWeekHigh > q.fiftyTwoWeekLow) {
      const posPct = Math.min(100, Math.max(0,
        ((q.price - q.fiftyTwoWeekLow) / (q.fiftyTwoWeekHigh - q.fiftyTwoWeekLow)) * 100));
      rangeHtml = `
        <div class="range-wrap" title="52-week: ${money(q.fiftyTwoWeekLow)} – ${money(q.fiftyTwoWeekHigh)}">
          <span class="range-end">${fmtNum.format(q.fiftyTwoWeekLow)}</span>
          <div class="range-track"><div class="range-marker" style="left:${posPct}%"></div></div>
          <span class="range-end">${fmtNum.format(q.fiftyTwoWeekHigh)}</span>
        </div>`;
    }
    return `
      <tr data-sym="${esc(sym)}">
        <td class="cell-sym">${esc(sym)}</td>
        <td class="cell-name" title="${esc(q.name || "")}">${esc(q.name || "")}</td>
        <td class="num cell-num">${money(q.price)}</td>
        <td class="num"><span class="chip ${dirClass(q.changePct)}">${pct(q.changePct)}</span></td>
        <td>${rangeHtml}</td>
        <td class="num">
          <button class="row-act act-own" data-act="own" title="I bought it — move to holdings">＋own</button>
          <button class="row-act" data-act="remove" title="Remove ${esc(sym)}">✕</button>
        </td>
      </tr>`;
  }).join("");
}

// ───────────────────────── Symbol validation ─────────────────────────

async function validateSymbol(sym) {
  sym = normalizeSymbol(sym);
  const [q] = await fetchQuotes([sym]);
  if (!q || q.error || q.price == null) {
    throw new Error(`"${sym}" not found on Yahoo Finance — check the ticker`);
  }
  quotes[q.symbol] = q;
  return q.symbol;
}

// ───────────────────────── CSV import ─────────────────────────

// Minimal CSV parser that handles quoted fields and commas inside quotes.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const HEADER_HINTS = {
  symbol: ["symbol", "ticker", "security id", "instrument"],
  shares: ["quantity", "shares", "qty", "share quantity"],
  cost: ["average cost basis", "average cost", "avg cost", "cost basis per share",
         "cost per share", "purchase price", "average price", "cost/share", "price paid",
         "unit cost",        // Merrill Edge holdings export
         "costbasisprice"],  // Interactive Brokers Flex Query (no spaces)
};

function findColumn(headers, hints) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const hint of hints) {
    const i = lower.findIndex((h) => h === hint);
    if (i !== -1) return i;
  }
  for (const hint of hints) {
    const i = lower.findIndex((h) => h.includes(hint));
    if (i !== -1) return i;
  }
  return -1;
}

const cleanNumber = (s) => {
  const v = parseFloat(String(s ?? "").replace(/[$,()\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

function extractPositions(rows) {
  // Brokers put preamble lines above the real header; find the row that has
  // both a symbol-ish and a quantity-ish column.
  for (let h = 0; h < Math.min(rows.length, 12); h++) {
    const si = findColumn(rows[h], HEADER_HINTS.symbol);
    const qi = findColumn(rows[h], HEADER_HINTS.shares);
    if (si === -1 || qi === -1) continue;
    const ci = findColumn(rows[h], HEADER_HINTS.cost);
    // Lot-level exports (Vanguard cost basis) repeat a symbol once per tax lot:
    // aggregate to one position per symbol with a share-weighted average cost.
    const agg = new Map();
    for (const r of rows.slice(h + 1)) {
      const sym = normalizeSymbol(String(r[si] ?? ""));
      const shares = cleanNumber(r[qi]);
      // Skip cash sweeps (SPAXX**), totals, "Pending Activity" and other non-ticker rows.
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym) || !shares || shares <= 0) continue;
      const cost = ci !== -1 ? cleanNumber(r[ci]) : null;
      const a = agg.get(sym) || { sym, shares: 0, costedShares: 0, totalCost: 0 };
      a.shares += shares;
      if (cost && cost > 0) { a.costedShares += shares; a.totalCost += cost * shares; }
      agg.set(sym, a);
    }
    const out = [...agg.values()].map((a) => ({
      sym: a.sym,
      shares: Math.round(a.shares * 1e4) / 1e4,
      cost: a.costedShares > 0 ? Math.round((a.totalCost / a.costedShares) * 1e4) / 1e4 : null,
    }));
    if (out.length) return out;
  }
  return [];
}

function guessSource(filename) {
  const f = (filename || "").toLowerCase();
  for (const [hint, label] of [["vanguard", "Vanguard"], ["etrade", "E*Trade"],
    ["e-trade", "E*Trade"], ["fidelity", "Fidelity"], ["schwab", "Schwab"],
    ["costbasis", "Vanguard"], ["robinhood", "Robinhood"], ["merrill", "Merrill"]]) {
    if (f.includes(hint)) return label;
  }
  return "";
}

// Identify which account a file belongs to by ticker overlap with each
// source's previous import — far more reliable than filenames.
function detectSourceByContent(positions) {
  const imported = new Set(positions.map((p) => p.sym));
  const bySrc = new Map();
  for (const p of state.portfolio) {
    if (p.src === "manual") continue;
    if (!bySrc.has(p.src)) bySrc.set(p.src, new Set());
    bySrc.get(p.src).add(p.sym);
  }
  let best = null, bestScore = 0;
  for (const [src, syms] of bySrc) {
    let inter = 0;
    for (const s of imported) if (syms.has(s)) inter++;
    const score = inter / Math.max(imported.size, syms.size);
    if (score > bestScore) { bestScore = score; best = src; }
  }
  return bestScore >= 0.5 ? best : null;
}

function openCsvReview(positions, filename) {
  const body = document.getElementById("csvReviewBody");
  body.innerHTML = positions.map((p, i) => `
    <tr data-i="${i}">
      <td><input type="checkbox" checked class="csv-include"></td>
      <td class="cell-sym">${esc(p.sym)}</td>
      <td class="num"><input type="number" step="any" min="0" class="csv-shares" value="${p.shares}"></td>
      <td class="num"><input type="number" step="any" min="0" class="csv-cost" value="${p.cost ?? ""}" placeholder="—"></td>
    </tr>`).join("");
  body.querySelectorAll(".csv-include").forEach((cb) =>
    cb.addEventListener("change", () => cb.closest("tr").classList.toggle("excluded", !cb.checked)));
  // Dropdown of sources: the standing brokerages, anything already imported,
  // and an escape hatch for a new one. Preselect from the filename.
  const known = [...new Set(["Vanguard", "E*Trade",
    ...state.portfolio.map((p) => p.src).filter((s) => s && s !== "manual")])];
  const sel = document.getElementById("csvSource");
  sel.innerHTML = known.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("") +
    `<option value="__other">Other…</option>`;
  // Prefer recognizing the account by its contents; fall back to the
  // filename. If neither identifies it, force an explicit choice rather
  // than defaulting to some existing source.
  const guess = detectSourceByContent(positions) || guessSource(filename);
  if (guess && known.includes(guess)) {
    sel.value = guess;
    document.getElementById("csvSourceOther").hidden = true;
  } else {
    sel.value = "__other";
    document.getElementById("csvSourceOther").hidden = false;
    document.getElementById("csvSourceOther").value = guess || "";
  }
  document.getElementById("csvApply").dataset.count = positions.length;
  // Payload must be set before the impact line and conflict list read it —
  // they compare the file's tickers against existing rows.
  document.getElementById("csvReviewBody").dataset.payload = JSON.stringify(positions);
  updateCsvImpact();
  renderCsvConflicts();
  document.getElementById("csvModal").hidden = false;
  document.querySelector("#csvModal .modal").focus();
}

// Spell out what Apply will do, so picking the wrong source can't silently
// wipe another account's rows.
function selectedCsvSource() {
  const sel = document.getElementById("csvSource").value;
  return sel === "__other"
    ? (document.getElementById("csvSourceOther").value.trim() || "import") : sel;
}

function updateCsvImpact() {
  const el = document.getElementById("csvImpact");
  const count = Number(document.getElementById("csvApply").dataset.count || 0);
  const mode = document.querySelector("input[name=csvMode]:checked").value;
  if (mode === "replace") {
    el.textContent = `Will clear the entire table (${state.portfolio.length} rows) and load ${count} rows from this file.`;
    el.classList.toggle("warn", state.portfolio.length > 0);
    return;
  }
  const src = selectedCsvSource();
  if (document.getElementById("csvSource").value === "__other"
      && !document.getElementById("csvSourceOther").value.trim()) {
    el.textContent = "Name the account this file came from before applying.";
    el.classList.add("warn");
    return;
  }
  if (src.toLowerCase() === "manual") {
    el.textContent = "“Manual” is reserved for hand-added rows — name the account something else.";
    el.classList.add("warn");
    return;
  }
  const prev = state.portfolio.filter((p) => p.src === src);
  if (!prev.length) {
    el.textContent = `First import from “${src}” — adds ${count} rows. Everything else is kept.`;
    el.classList.remove("warn");
    return;
  }
  const fileSyms = new Set(
    JSON.parse(document.getElementById("csvReviewBody").dataset.payload || "[]").map((p) => p.sym));
  const matches = prev.filter((p) => fileSyms.has(p.sym)).length;
  el.textContent =
    `Will replace the ${prev.length} rows previously imported as “${src}” with ${count} rows from this file `
    + `(${matches} of ${prev.length} tickers match). Everything else is kept.`
    + (matches / prev.length < 0.5 ? " Low overlap — is this really the same account?" : "");
  el.classList.add("warn");
}

// Tickers in the file that also exist as Manual rows would silently
// double-count when combined (a manual stop-gap for the same shares the
// broker file now includes). Make the choice explicit per ticker:
// keep both (separate lots) or let the file's row absorb the manual one.
function renderCsvConflicts() {
  const box = document.getElementById("csvConflicts");
  const list = document.getElementById("csvConflictList");
  const mode = document.querySelector("input[name=csvMode]:checked").value;
  const payload = JSON.parse(document.getElementById("csvReviewBody").dataset.payload || "[]");
  const bySym = new Map(payload.map((p) => [p.sym, p]));
  const conflicts = mode === "replace" ? []
    : state.portfolio.filter((p) => p.src === "manual" && bySym.has(p.sym));
  box.hidden = !conflicts.length;
  list.innerHTML = conflicts.map((p) => {
    const inc = bySym.get(p.sym);
    return `
    <div class="conflict-row" data-sym="${esc(p.sym)}">
      <span class="cell-sym">${esc(p.sym)}</span>
      <label><input type="radio" name="cf-${esc(p.sym)}" value="keep" checked>
        Keep both — shows ${fmtShares.format(p.shares + inc.shares)} sh
        (manual ${fmtShares.format(p.shares)} + file ${fmtShares.format(inc.shares)})</label>
      <label><input type="radio" name="cf-${esc(p.sym)}" value="replace">
        File replaces my manual row — shows ${fmtShares.format(inc.shares)} sh</label>
    </div>`;
  }).join("");
}

async function applyCsvImport() {
  const body = document.getElementById("csvReviewBody");
  const base = JSON.parse(body.dataset.payload || "[]");
  const picked = [];
  body.querySelectorAll("tr").forEach((tr) => {
    if (!tr.querySelector(".csv-include").checked) return;
    const i = Number(tr.dataset.i);
    const shares = parseFloat(tr.querySelector(".csv-shares").value);
    const cost = parseFloat(tr.querySelector(".csv-cost").value);
    if (shares > 0) picked.push({ sym: base[i].sym, shares, cost: cost > 0 ? cost : null });
  });

  const mode = document.querySelector("input[name=csvMode]:checked").value;
  if (document.getElementById("csvSource").value === "__other"
      && !document.getElementById("csvSourceOther").value.trim()) {
    document.getElementById("csvSourceOther").focus();
    return; // impact line already says a name is required
  }
  const src = selectedCsvSource();
  if (src.toLowerCase() === "manual") {
    document.getElementById("csvSourceOther").focus();
    return; // impact line explains the name is reserved
  }
  // Mislabeled-source guard: replacing a source whose previous tickers
  // barely appear in this file is almost certainly the wrong account.
  if (mode === "source") {
    const prev = state.portfolio.filter((p) => p.src === src);
    const fileSyms = new Set(picked.map((p) => p.sym));
    const matches = prev.filter((p) => fileSyms.has(p.sym)).length;
    if (prev.length && matches / prev.length < 0.5 && !confirm(
      `Only ${matches} of the ${prev.length} tickers previously imported as “${src}” appear in this file — `
      + `it may be from a different account. Replace “${src}”'s rows anyway?`)) return;

    // Rows hand-edited since the last import that the file would undo: make
    // the choice explicit instead of silently reverting (stale-file case).
    const incoming = new Map(picked.map((p) => [p.sym, p]));
    const conflicts = prev.filter((p) => p.editedAt).map((p) => {
      const inc = incoming.get(p.sym);
      if (!inc) return `${p.sym} — yours: ${fmtShares.format(p.shares)} sh, not in this file`;
      if (inc.shares !== p.shares || (p.cost != null && inc.cost !== p.cost)) {
        return `${p.sym} — yours: ${fmtShares.format(p.shares)} sh, file: ${fmtShares.format(inc.shares)} sh`;
      }
      return null;
    }).filter(Boolean);
    if (conflicts.length && !confirm(
      `You hand-edited these “${src}” rows after its last import, and this file disagrees:\n\n`
      + conflicts.join("\n")
      + `\n\nOK uses the file's numbers (right if the file is newer than your edits). `
      + `Cancel keeps everything as is — re-export a fresh file from the broker instead.`)) return;
  }
  // Manual rows the user chose to let this file absorb (conflict radios).
  // Only honored when the file's row is actually being applied — unchecking
  // the row in the review must not delete the manual one with nothing to
  // replace it.
  const absorb = new Set();
  document.querySelectorAll("#csvConflictList .conflict-row").forEach((row) => {
    if (row.querySelector("input[value=replace]")?.checked) absorb.add(row.dataset.sym);
  });
  const pickedSyms = new Set(picked.map((p) => p.sym));
  // Re-importing a source replaces exactly that source's previous rows, so a
  // weekly re-import of the same file is idempotent and never double-counts.
  if (mode === "replace") state.portfolio = [];
  else state.portfolio = state.portfolio.filter((p) => p.src !== src
    && !(p.src === "manual" && absorb.has(p.sym) && pickedSyms.has(p.sym)));
  for (const p of picked) state.portfolio.push({ ...p, src });
  saveState();
  document.getElementById("csvModal").hidden = true;
  renderPortfolio();
  await refresh(); // pick up names/prices for new tickers
}

function exportCSV() {
  // Quote any field that could hold a comma or quote (user-typed source
  // names) so the export stays parseable — including by our own importer.
  const field = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["Symbol,Shares,Average Cost,Source"];
  state.portfolio.forEach((p) =>
    lines.push([p.sym, p.shares, p.cost ?? "", p.src].map(field).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `foliopeek-holdings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ───────────────────────── Wiring ─────────────────────────

// ───────────────────────── Distributions ─────────────────────────

const DIST_CATS = {
  MUTUALFUND: { label: "Mutual funds", color: "#1d6b45" },
  ETF: { label: "Index funds / ETFs", color: "#8a6d1f" },
  EQUITY: { label: "Stocks", color: "#211d16" },
};
const DIST_OTHER = { label: "Other", color: "#a39a89" };

function arcPath(cx, cy, r, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)}
          A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)}`;
}

function renderDistributions() {
  const { rows } = portfolioRows();
  const cats = new Map();
  let total = 0;
  let unpriced = 0;
  for (const r of rows) {
    if (r.value == null) { unpriced++; continue; }
    const meta = DIST_CATS[quotes[r.sym]?.quoteType] || DIST_OTHER;
    const c = cats.get(meta.label) || { ...meta, value: 0, count: 0, syms: [] };
    c.value += r.value;
    c.count++;
    c.syms.push(r.sym);
    cats.set(meta.label, c);
    total += r.value;
  }
  const list = [...cats.values()].sort((a, b) => b.value - a.value);

  const svg = document.getElementById("distChart");
  const legend = document.getElementById("distLegend");
  const note = document.getElementById("distNote");
  if (!list.length) {
    svg.innerHTML = "";
    legend.innerHTML = `<p class="empty-note" style="border:none">Nothing to chart yet — add holdings and refresh quotes first.</p>`;
    return;
  }

  // Donut: stroke arcs with a small gap between segments; full circle when
  // a single category holds everything.
  const cx = 120, cy = 120, r = 86, width = 40, gap = 0.03;
  let parts = "";
  let angle = -Math.PI / 2;
  for (const c of list) {
    const sweep = (c.value / total) * Math.PI * 2;
    const title = `<title>${esc(c.label)} — ${esc(c.syms.join(", "))}</title>`;
    if (list.length === 1) {
      parts += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c.color}" stroke-width="${width}">${title}</circle>`;
    } else {
      const a0 = angle + gap / 2, a1 = angle + sweep - gap / 2;
      parts += `<path d="${arcPath(cx, cy, r, a0, Math.max(a1, a0 + 0.005))}" fill="none"
        stroke="${c.color}" stroke-width="${width}" stroke-linecap="butt">${title}</path>`;
    }
    angle += sweep;
  }
  parts += `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="dist-center-value">${moneyBig(total)}</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="dist-center-label">${rows.length - unpriced} holdings</text>`;
  svg.innerHTML = parts;

  legend.innerHTML = list.map((c) => `
    <div class="dist-row" title="${esc(c.syms.join(", "))}">
      <span class="dist-swatch" style="background:${c.color}"></span>
      <span class="dist-cat">${esc(c.label)}<span class="dist-count">${c.count} holding${c.count > 1 ? "s" : ""}</span></span>
      <span class="dist-val">${moneyBig(c.value)}</span>
      <span class="dist-pct">${((c.value / total) * 100).toFixed(1)}%</span>
    </div>`).join("");

  note.textContent = "Categories follow Yahoo Finance's instrument type: mutual funds, index funds / ETFs, and individual stocks."
    + (unpriced ? ` ${unpriced} holding${unpriced > 1 ? "s" : ""} without a price ${unpriced > 1 ? "are" : "is"} not charted.` : "");

  renderSectorBars();
  renderHistoryChart();
}

// ─────────────── Stocks by sector ───────────────
// Sector/industry are static facts; cache them in localStorage so they're
// fetched once per symbol, ever.

let sectors = {};
try { sectors = JSON.parse(localStorage.getItem("ledger.sectors.v1")) || {}; } catch { /* fresh */ }
let sectorsLoading = false;

async function ensureSectors(syms) {
  const missing = syms.filter((s) => !sectors[s]);
  if (!missing.length || sectorsLoading) return;
  sectorsLoading = true;
  try {
    const BATCH = 40;
    for (let i = 0; i < missing.length; i += BATCH) {
      const res = await fetch(`/api/sectors?symbols=${encodeURIComponent(missing.slice(i, i + BATCH).join(","))}`);
      if (!res.ok) return;
      for (const p of (await res.json()).quotes || []) {
        if (p.sector) sectors[p.symbol] = { sector: p.sector, industry: p.industry };
      }
    }
    localStorage.setItem("ledger.sectors.v1", JSON.stringify(sectors));
  } finally {
    sectorsLoading = false;
  }
}

function renderSectorBars() {
  const bars = document.getElementById("sectorBars");
  const note = document.getElementById("sectorNote");
  const { rows } = portfolioRows();
  const stocks = rows.filter((r) => quotes[r.sym]?.quoteType === "EQUITY" && r.value != null);
  if (!stocks.length) {
    bars.innerHTML = "";
    note.textContent = "No priced individual stocks to break down yet.";
    return;
  }

  const total = stocks.reduce((s, r) => s + r.value, 0);
  const groups = new Map();
  let pending = 0;
  for (const r of stocks) {
    const info = sectors[r.sym];
    if (!info) { pending++; continue; }
    const g = groups.get(info.sector) || { sector: info.sector, value: 0, count: 0, details: [] };
    g.value += r.value;
    g.count++;
    g.details.push(`${r.sym} — ${info.industry || "?"} (${moneyBig(r.value)})`);
    groups.set(info.sector, g);
  }
  const list = [...groups.values()].sort((a, b) => b.value - a.value);
  const max = list.length ? list[0].value : 1;

  bars.innerHTML = list.map((g) => `
    <div class="sector-row" title="${esc(g.details.join("\n"))}">
      <span class="sector-name">${esc(g.sector)}<span class="sector-count">${g.count} stock${g.count > 1 ? "s" : ""}</span></span>
      <div class="sector-track"><div class="sector-fill" style="width:${(g.value / max) * 100}%"></div></div>
      <span class="sector-val">${moneyBig(g.value)}</span>
      <span class="sector-pct">${((g.value / total) * 100).toFixed(1)}%</span>
    </div>`).join("");

  note.textContent = "Sectors are Yahoo Finance's standard (GICS-style) classification — hover a row for each stock's industry. Percentages are of your individual stocks only, not funds."
    + (pending ? ` Looking up ${pending} symbol${pending > 1 ? "s" : ""}…` : "");

  if (pending) {
    ensureSectors(stocks.map((r) => r.sym)).then(() => {
      // re-render once lookups land, if the tab is still showing
      if (!document.querySelector("[data-panel=distributions]").hidden) renderSectorBars();
    });
  }
}

// ─────────────── Value over time ───────────────

function renderHistoryChart() {
  const svg = document.getElementById("histChart");
  const note = document.getElementById("histNote");
  const pts = valueHistory.slice().sort((a, b) => (a.d < b.d ? -1 : 1));
  if (pts.length < 2) {
    svg.innerHTML = "";
    svg.style.display = "none";
    note.textContent = "History starts today — a snapshot of your total value is kept for each day you open the page, and the chart appears once there are two.";
    return;
  }
  svg.style.display = "";
  const W = 720, H = 200, padL = 12, padR = 84, padT = 16, padB = 28;
  const t0 = Date.parse(pts[0].d), t1 = Date.parse(pts[pts.length - 1].d);
  let lo = Math.min(...pts.map((p) => p.total));
  let hi = Math.max(...pts.map((p) => p.total));
  if (hi === lo) { hi *= 1.005; lo *= 0.995; }
  const X = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const Y = (v) => padT + ((hi - v) / (hi - lo)) * (H - padT - padB);
  const path = pts.map((p, i) =>
    `${i ? "L" : "M"} ${X(Date.parse(p.d)).toFixed(1)} ${Y(p.total).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const fmtD = (d) => new Date(d + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" });

  svg.innerHTML = `
    <line x1="${padL}" y1="${Y(hi)}" x2="${W - padR}" y2="${Y(hi)}" class="hist-grid"/>
    <line x1="${padL}" y1="${Y(lo)}" x2="${W - padR}" y2="${Y(lo)}" class="hist-grid"/>
    <path d="${path}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${X(t1).toFixed(1)}" cy="${Y(last.total).toFixed(1)}" r="3.5" fill="var(--gain)"/>
    <text x="${X(t1) + 9}" y="${Y(last.total) + 4}" class="hist-label-strong">${moneyBig(last.total)}</text>
    <text x="${padL + 4}" y="${Y(hi) - 6}" class="hist-label">${moneyBig(hi)}</text>
    <text x="${padL + 4}" y="${Y(lo) + 15}" class="hist-label">${moneyBig(lo)}</text>
    <text x="${padL}" y="${H - 2}" class="hist-label">${fmtD(pts[0].d)}</text>
    <text x="${W - padR}" y="${H - 2}" text-anchor="end" class="hist-label">${fmtD(last.d)}</text>`;

  const delta = last.total - pts[0].total;
  note.textContent = `${pts.length} daily snapshots since ${fmtD(pts[0].d)} — `
    + `${delta >= 0 ? "up" : "down"} ${moneyBig(Math.abs(delta))} (${((delta / pts[0].total) * 100).toFixed(1)}%) over that span. `
    + "A snapshot is kept for each day the page is opened.";
}

// ───────────────────────── Tabs ─────────────────────────

function setTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on);
  });
  document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
  localStorage.setItem("ledger.tab", name);
  if (name === "distributions") renderDistributions();
}

function renderSourceOptions() {
  const sel = document.getElementById("addSource");
  const prev = sel.value;
  const known = [...new Set(["manual", "Vanguard", "E*Trade", ...state.portfolio.map((p) => p.src)])];
  sel.innerHTML = known
    .map((s) => `<option value="${esc(s)}">${s === "manual" ? "Manual" : esc(s)}</option>`)
    .join("");
  if (known.includes(prev)) sel.value = prev;
}

function renderAll() {
  renderIndexes();
  renderPortfolio();
  renderWatchlist();
  renderSourceOptions();
  const distPanel = document.querySelector("[data-panel=distributions]");
  if (distPanel && !distPanel.hidden) renderDistributions();
}

function wire() {
  document.getElementById("refreshBtn").addEventListener("click", refresh);

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => setTab(t.dataset.tab)));
  setTab(localStorage.getItem("ledger.tab") || "holdings");

  // column sorting
  document.querySelectorAll("#portfolioTable th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else { sortKey = key; sortDir = ["symbol", "name", "sourceLabel"].includes(key) ? 1 : -1; }
      renderPortfolio();
    });
  });

  // portfolio row actions + inline edit
  document.getElementById("portfolioBody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    const sym = tr.dataset.sym;
    if (e.target.dataset.act === "remove") {
      const n = state.portfolio.filter((p) => p.sym === sym).length;
      if (confirm(`Remove ${sym} from holdings?${n > 1 ? ` (held in ${n} sources — removes all)` : ""}`)) {
        state.portfolio = state.portfolio.filter((p) => p.sym !== sym);
        saveState();
        renderPortfolio();
      }
    } else if (e.target.dataset.edit) {
      startCellEdit(e.target, sym, e.target.dataset.edit);
    }
  });

  // add position
  document.getElementById("addPositionForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("addError");
    const btn = document.getElementById("addPositionBtn");
    errEl.textContent = "";
    const symRaw = document.getElementById("addSymbol").value.trim().toUpperCase();
    const shares = parseFloat(document.getElementById("addShares").value);
    const cost = parseFloat(document.getElementById("addCost").value);
    if (!symRaw || !(shares > 0)) return;
    btn.disabled = true;
    try {
      const sym = await validateSymbol(symRaw);
      const src = document.getElementById("addSource").value || "manual";
      const existing = state.portfolio.find((p) => p.sym === sym && p.src === src);
      if (existing) { existing.shares += shares; if (cost > 0) existing.cost = cost; }
      else state.portfolio.push({ sym, shares, cost: cost > 0 ? cost : null, src });
      if (src !== "manual") {
        state.portfolio.find((p) => p.sym === sym && p.src === src).editedAt = Date.now();
      }
      state.watchlist = state.watchlist.filter((s) => s !== sym); // owned now
      saveState();
      e.target.reset();
      renderAll();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // watchlist actions
  document.getElementById("watchBody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    const sym = tr.dataset.sym;
    const act = e.target.dataset.act;
    if (act === "remove") {
      state.watchlist = state.watchlist.filter((s) => s !== sym);
      saveState();
      renderWatchlist();
    } else if (act === "own") {
      // Pre-fill the holdings form so the user just types share count.
      setTab("holdings");
      document.getElementById("addSymbol").value = sym;
      const sharesEl = document.getElementById("addShares");
      document.getElementById("addPositionForm").scrollIntoView({ behavior: "smooth", block: "center" });
      sharesEl.focus();
      document.getElementById("addPositionForm").classList.add("flash");
      setTimeout(() => document.getElementById("addPositionForm").classList.remove("flash"), 900);
    }
  });

  // add to watchlist
  document.getElementById("addWatchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("watchError");
    const btn = document.getElementById("addWatchBtn");
    errEl.textContent = "";
    const symRaw = document.getElementById("watchSymbol").value.trim().toUpperCase();
    if (!symRaw) return;
    btn.disabled = true;
    try {
      const sym = await validateSymbol(symRaw);
      if (state.portfolio.some((p) => p.sym === sym)) throw new Error(`You already own ${sym} — it's in Holdings`);
      if (!state.watchlist.includes(sym)) state.watchlist.push(sym);
      saveState();
      e.target.reset();
      renderWatchlist();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // CSV import
  document.getElementById("csvInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    const positions = extractPositions(parseCSV(text));
    if (!positions.length) {
      alert("Couldn't find ticker + share columns in that file. Expected a broker positions export with columns like Symbol and Quantity.");
      return;
    }
    openCsvReview(positions, file.name);
  });
  document.getElementById("csvCancel").addEventListener("click", () => {
    document.getElementById("csvModal").hidden = true;
  });
  document.getElementById("csvModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });
  document.getElementById("csvApply").addEventListener("click", applyCsvImport);
  document.getElementById("csvSource").addEventListener("change", (e) => {
    const other = document.getElementById("csvSourceOther");
    other.hidden = e.target.value !== "__other";
    if (!other.hidden) other.focus();
    updateCsvImpact();
    renderCsvConflicts();
  });
  document.getElementById("csvSourceOther").addEventListener("input", updateCsvImpact);
  document.querySelectorAll("input[name=csvMode]").forEach((r) =>
    r.addEventListener("change", () => { updateCsvImpact(); renderCsvConflicts(); }));
  document.addEventListener("keydown", (e) => {
    const modal = document.getElementById("csvModal");
    if (e.key === "Escape" && !modal.hidden) modal.hidden = true;
  });

  // movers strip → jump to the holding's row
  document.getElementById("moversStrip").addEventListener("click", (e) => {
    const btn = e.target.closest(".mover");
    if (!btn) return;
    const tr = document.querySelector(`#portfolioBody tr[data-sym="${CSS.escape(btn.dataset.sym)}"]`);
    if (!tr) return;
    tr.scrollIntoView({ behavior: "smooth", block: "center" });
    tr.classList.add("flash");
    setTimeout(() => tr.classList.remove("flash"), 900);
  });

  document.getElementById("exportBtn").addEventListener("click", exportCSV);

  document.getElementById("clearBtn").addEventListener("click", () => {
    const n = state.portfolio.length;
    if (!n) return;
    if (confirm(`Remove all ${n} holdings? The watchlist is kept. Tip: Export first if you want a backup.`)) {
      state.portfolio = [];
      saveState();
      renderPortfolio();
    }
  });

  // Auto-refresh while the tab is visible: every 5 minutes during regular
  // trading hours, every 30 when the market is closed (regularMarketPrice
  // doesn't move off-hours, so faster polling returns identical data).
  const REFRESH_OPEN_MS = 300_000, REFRESH_CLOSED_MS = 1_800_000;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    const open = quotes["^GSPC"]?.marketOpen ?? true; // assume open until first quote arrives
    refreshTimer = setTimeout(async () => {
      if (!document.hidden) await refresh();
      scheduleRefresh();
    }, open ? REFRESH_OPEN_MS : REFRESH_CLOSED_MS);
  }
  scheduleRefresh();
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) return;
    await refresh();
    scheduleRefresh(); // re-pick cadence from the fresh marketOpen flag
  });
}

wire();
renderAll();
refresh();
maybeRestoreBackup();
