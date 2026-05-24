"use strict";

/**
 * NSE Discovery feeds — trader-curated lists published by NSE.
 *
 * Free, no auth, public JSON endpoints. We hit the homepage once to warm
 * cookies (some endpoints need a session) then fetch each list.
 *
 * Exported:
 *   getDiscovery()  →  { highs52w, lows52w, topGainers, topLosers,
 *                       mostActiveVol, bulkDeals, blockDeals, oiBuildup,
 *                       fetchedAt }
 *
 * Any individual feed failure is non-fatal — that feed is returned as [].
 */

const fs   = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "nse_discovery_cache.json");
const CACHE_TTL  = 12 * 60 * 60 * 1000; // 12 hours

const BASE = "https://www.nseindia.com";
const UA   = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

let cookieJar = "";

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function warmCookies() {
  const res = await fetch(BASE + "/", { headers: { "User-Agent": UA } });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  cookieJar = setCookies.map((c) => c.split(";")[0]).join("; ");
}

async function fetchJson(url, referer = BASE + "/") {
  if (!cookieJar) await warmCookies();
  const headers = {
    "User-Agent":      UA,
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         referer,
  };
  if (cookieJar) headers.Cookie = cookieJar;

  const res = await fetch(url, { headers });
  if (res.status === 401 || res.status === 403) {
    // Retry once after fresh cookie warm
    await warmCookies();
    headers.Cookie = cookieJar;
    const r2 = await fetch(url, { headers });
    if (!r2.ok) throw new Error(`${url} → ${r2.status}`);
    return r2.json();
  }
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// ─── Feed fetchers ────────────────────────────────────────────────────────────

async function fetch52wHighs() {
  const j = await fetchJson(BASE + "/api/live-analysis-data-52weekhighstock",
                            BASE + "/market-data/52-week-high-equity-market");
  return (j.data ?? []).map((d) => ({
    symbol:   d.symbol,
    company:  d.comapnyName,           // NSE typo in API
    ltp:      d.ltp,
    new52wH:  d.new52WHL,
    prev52wH: d.prev52WHL,
    change:   d.change,
    pChange:  d.pChange,
    series:   d.series,
  })).filter((d) => d.series === "EQ");
}

async function fetch52wLows() {
  const j = await fetchJson(BASE + "/api/live-analysis-data-52weeklowstock",
                            BASE + "/market-data/52-week-low-equity-market");
  return (j.data ?? []).map((d) => ({
    symbol:   d.symbol,
    company:  d.comapnyName,
    ltp:      d.ltp,
    new52wL:  d.new52WHL,
    prev52wL: d.prev52WHL,
    change:   d.change,
    pChange:  d.pChange,
    series:   d.series,
  })).filter((d) => d.series === "EQ");
}

async function fetchGainersLosers(direction = "gainers") {
  // NSE's /api/live-analysis-variations?index=gainers returns a rich
  // object: { NIFTY: { data: [...] }, BANKNIFTY: {...}, NIFTYNEXT50: {...} }.
  // Querying ?index=losers historically returned "Missing index or key."
  // because NSE migrated losers behind a different endpoint. We work around
  // by querying the gainers endpoint and (if losers requested) re-querying
  // the loser-list endpoint at /api/live-analysis-most-loosers.
  const url = direction === "losers"
    ? `${BASE}/api/live-analysis-most-loosers`
    : `${BASE}/api/live-analysis-variations?index=gainers`;
  const j = await fetchJson(url, BASE + "/market-data/top-gainers-losers");

  // NSE error responses: { data: "Missing index or key." }
  if (j && typeof j.data === "string") return [];

  // Prefer NIFTY data, fall back to a flat data array
  const grp = j.NIFTY ?? j.NIFTY100 ?? j["NIFTY 100"] ?? j;
  let arr = Array.isArray(grp) ? grp : grp?.data;
  if (!Array.isArray(arr)) arr = Array.isArray(j.data) ? j.data : [];
  return arr.map((d) => ({
    symbol:   d.symbol,
    ltp:      d.ltp,
    pChange:  d.perChange ?? d.pChange,
    netPrice: d.netPrice,
    tradedQty: d.tradedQuantity,
    turnover: d.turnoverInLakhs,
  }));
}

async function fetchMostActive() {
  const j = await fetchJson(BASE + "/api/live-analysis-most-active-securities?index=volume",
                            BASE + "/market-data/most-active-equities");
  return (j.data ?? j.NIFTY ?? []).map((d) => ({
    symbol:    d.symbol,
    ltp:       d.lastPrice ?? d.ltp,
    pChange:   d.pChange,
    tradedQty: d.tradedQuantity ?? d.totalTradedVolume,
    turnover:  d.turnover ?? d.totalTradedValue,
  })).slice(0, 25);
}

// Parse a CSV line handling quoted fields with commas
function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// NSE Archives publishes the last 4-5 trading days of bulk/block deals as a
// publicly accessible CSV at nsearchives.nseindia.com. This is much more
// reliable than the cookie-protected JSON API which 503s frequently.
async function fetchBulkDealsCsv() {
  const res = await fetch("https://nsearchives.nseindia.com/content/equities/bulk.csv", {
    headers: { "User-Agent": UA, "Accept": "text/csv,text/plain,*/*" },
  });
  if (!res.ok) throw new Error(`bulk.csv → ${res.status}`);
  const text = await res.text();
  return parseDealsCsv(text);
}

async function fetchBlockDealsCsv() {
  const res = await fetch("https://nsearchives.nseindia.com/content/equities/block.csv", {
    headers: { "User-Agent": UA, "Accept": "text/csv,text/plain,*/*" },
  });
  if (!res.ok) throw new Error(`block.csv → ${res.status}`);
  const text = await res.text();
  return parseDealsCsv(text);
}

function parseDealsCsv(csv) {
  // Header: Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,
  //         Trade Price / Wght. Avg. Price[,Remarks]
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const iDate = header.findIndex((h) => /^date/i.test(h));
  const iSym  = header.findIndex((h) => /symbol/i.test(h));
  const iCli  = header.findIndex((h) => /client/i.test(h));
  const iBs   = header.findIndex((h) => /buy.?sell/i.test(h));
  const iQty  = header.findIndex((h) => /quantity/i.test(h));
  const iPx   = header.findIndex((h) => /price/i.test(h));
  if (iSym < 0 || iBs < 0) return [];

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (row.length < 5) continue;
    const symbol = row[iSym];
    const bs = (row[iBs] || "").toUpperCase();
    if (!symbol || !bs) continue;
    out.push({
      date:   row[iDate],
      symbol,
      client: row[iCli] || "",
      bs,
      qty:    parseInt(row[iQty].replace(/,/g, ""), 10) || 0,
      price:  parseFloat(row[iPx].replace(/,/g, "")) || 0,
    });
  }
  return out;
}

async function fetchOiBuildup() {
  // F&O long & short buildup — NSE classifies by combining OI change & price change:
  //   price↑ + OI↑ = Long Buildup
  //   price↓ + OI↑ = Short Buildup
  //   price↑ + OI↓ = Short Covering
  //   price↓ + OI↓ = Long Unwinding
  const j = await fetchJson(BASE + "/api/snapshot-derivatives-equity?index=oi_change",
                            BASE + "/market-data/oi-spurts");
  // Possible shapes: {LONG_BUILDUP:[…]} OR {data:[…]} (flat list to classify)
  // OR markets closed: {data:[], msg:"No Data Found"}.
  function norm(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 20).map((d) => ({
      symbol:      d.underlying ?? d.symbol,
      ltp:         d.latestLTP ?? d.ltp ?? null,
      pChange:     d.percentChange ?? d.pChange,
      oiChangePct: d.oichangePer ?? d.oiChangePercent ?? d.oiChangePerc,
    }));
  }

  // Pre-categorized shape
  if (j.LONG_BUILDUP || j.longBuildUp) {
    return {
      longBuildup:   norm(j.LONG_BUILDUP   ?? j.longBuildUp   ?? []),
      shortBuildup:  norm(j.SHORT_BUILDUP  ?? j.shortBuildUp  ?? []),
      shortCovering: norm(j.SHORT_COVERING ?? j.shortCovering ?? []),
      longUnwinding: norm(j.LONG_UNWINDING ?? j.longUnwinding ?? []),
    };
  }

  // Flat shape: classify ourselves
  const arr = Array.isArray(j.data) ? j.data : [];
  const cat = { longBuildup: [], shortBuildup: [], shortCovering: [], longUnwinding: [] };
  for (const raw of arr) {
    const d = {
      symbol:      raw.underlying ?? raw.symbol,
      ltp:         raw.latestLTP ?? raw.ltp ?? null,
      pChange:     raw.percentChange ?? raw.pChange,
      oiChangePct: raw.oichangePer ?? raw.oiChangePercent ?? raw.oiChangePerc,
    };
    if (!d.symbol || d.pChange == null || d.oiChangePct == null) continue;
    if (d.pChange > 0 && d.oiChangePct > 0)      cat.longBuildup.push(d);
    else if (d.pChange < 0 && d.oiChangePct > 0) cat.shortBuildup.push(d);
    else if (d.pChange > 0 && d.oiChangePct < 0) cat.shortCovering.push(d);
    else if (d.pChange < 0 && d.oiChangePct < 0) cat.longUnwinding.push(d);
  }
  // Sort each category by abs(OI change) and trim
  for (const k of Object.keys(cat)) {
    cat[k].sort((a, b) => Math.abs(b.oiChangePct) - Math.abs(a.oiChangePct));
    cat[k] = cat[k].slice(0, 20);
  }
  return cat;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) { /* ignore */ }
  return null;
}

function saveCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE + ".tmp", JSON.stringify(data));
    fs.renameSync(CACHE_FILE + ".tmp", CACHE_FILE);
  } catch (e) { /* ignore */ }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getDiscovery({ force = false } = {}) {
  const prev = loadCache();
  if (!force && prev && Date.now() - new Date(prev.fetchedAt).getTime() < CACHE_TTL) return prev;

  // Run each fetch independently — any failure becomes an empty list rather
  // than failing the whole pipeline.
  const safe = async (fn, fallback, label) => {
    try { return await fn(); } catch (e) { console.warn(`  ⚠ ${label || fn.name}: ${e.message}`); return fallback; }
  };

  const [highs52w, lows52w, topGainers, topLosers, mostActiveVol, oiBuildup, bulkDeals, blockDeals] = await Promise.all([
    safe(fetch52wHighs, [], "fetch52wHighs"),
    safe(fetch52wLows,  [], "fetch52wLows"),
    safe(() => fetchGainersLosers("gainers"), [], "gainers"),
    safe(() => fetchGainersLosers("losers"),  [], "losers"),
    safe(fetchMostActive, [], "mostActive"),
    safe(fetchOiBuildup, { longBuildup: [], shortBuildup: [], shortCovering: [], longUnwinding: [] }, "oiBuildup"),
    safe(fetchBulkDealsCsv,  [], "bulkDealsCsv"),
    safe(fetchBlockDealsCsv, [], "blockDealsCsv"),
  ]);

  // Carry-forward strategy: if a particular feed came back empty AND the
  // previous cache had non-empty data for it, retain the previous data and
  // record it as "stale" with a fromDate. Saturday/Sunday/holidays then keep
  // showing Friday's bulk deals, OI buildup, etc.
  const carryForward = (now, before, key) => {
    const cur = now[key];
    const cnt = Array.isArray(cur) ? cur.length
              : cur && typeof cur === "object" ? Object.values(cur).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0)
              : 0;
    if (cnt > 0) return { value: cur, stale: false };
    if (before && before[key]) {
      const beforeCnt = Array.isArray(before[key]) ? before[key].length
                      : before[key] && typeof before[key] === "object" ? Object.values(before[key]).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0)
                      : 0;
      if (beforeCnt > 0) {
        return { value: before[key], stale: true };
      }
    }
    return { value: cur, stale: false };
  };

  const fresh = { highs52w, lows52w, topGainers, topLosers, mostActiveVol, oiBuildup, bulkDeals, blockDeals };
  const out = { fetchedAt: new Date().toISOString() };
  const staleFeeds = [];
  for (const key of Object.keys(fresh)) {
    const { value, stale } = carryForward(fresh, prev, key);
    out[key] = value;
    if (stale) staleFeeds.push(key);
  }
  if (staleFeeds.length > 0) {
    out.staleFeeds = staleFeeds;
    out.staleFrom  = prev?.fetchedAt ?? null;
  }
  saveCache(out);
  return out;
}

// ─── Build a quick lookup map from discovery feeds to per-symbol bonuses ──────

function buildSymbolBonuses(disc) {
  const bonus = {};   // { SYMBOL → { in52wHi, isGainer, bulkBuy, blockBuy, oiLong, oiShortCover, oiShortBuild, oiLongUnwind, sources[] } }
  const set = (sym, key, val = true) => {
    if (!sym) return;
    if (!bonus[sym]) bonus[sym] = { sources: [] };
    bonus[sym][key] = val;
    bonus[sym].sources.push(key);
  };

  for (const d of disc.highs52w || [])     set(d.symbol, "in52wHi");
  for (const d of disc.topGainers || [])   if (Math.abs(d.pChange ?? 0) >= 3) set(d.symbol, "isGainer", d.pChange);
  for (const d of disc.mostActiveVol || []) set(d.symbol, "isMostActive");
  for (const d of disc.bulkDeals || [])    if (d.bs === "BUY") set(d.symbol, "bulkBuy");
  for (const d of disc.blockDeals || [])   if (d.bs === "BUY") set(d.symbol, "blockBuy");
  for (const d of disc.oiBuildup?.longBuildup   || []) set(d.symbol, "oiLong");
  for (const d of disc.oiBuildup?.shortCovering || []) set(d.symbol, "oiShortCover");

  // Bearish flags (used to penalize, not boost):
  for (const d of disc.lows52w || [])     set(d.symbol, "in52wLo");
  for (const d of disc.topLosers || [])   if ((d.pChange ?? 0) <= -3) set(d.symbol, "isLoser", d.pChange);
  for (const d of disc.oiBuildup?.shortBuildup   || []) set(d.symbol, "oiShort");
  for (const d of disc.oiBuildup?.longUnwinding || []) set(d.symbol, "oiLongUnwind");

  return bonus;
}

module.exports = { getDiscovery, buildSymbolBonuses };
