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
  // NSE has /api/live-analysis-variations?index=gainers / losers
  const j = await fetchJson(`${BASE}/api/live-analysis-variations?index=${direction}`,
                            BASE + "/market-data/top-gainers-losers");
  // NIFTY 100 group is the most useful for our purposes
  const grp = j.NIFTY ?? j.NIFTY100 ?? j["NIFTY 100"] ?? j;
  const arr = Array.isArray(grp) ? grp : (grp?.data ?? []);
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

function ddmmyyyy(d) {
  return `${String(d.getDate()).padStart(2,"0")}-${d.toLocaleString("en-US",{month:"short"})}-${d.getFullYear()}`;
}

async function fetchBulkDeals() {
  // Last 5 trading days
  const to    = new Date();
  const from  = new Date(); from.setDate(to.getDate() - 7);
  const url   = `${BASE}/api/historical/cm/bulk?from=${encodeURIComponent(ddmmyyyy(from))}&to=${encodeURIComponent(ddmmyyyy(to))}`;
  const j     = await fetchJson(url, BASE + "/market-data/bulk-deals");
  return (j.data ?? []).map((d) => ({
    date:     d.BD_DT_DATE ?? d.date,
    symbol:   d.BD_SYMBOL ?? d.symbol,
    client:   d.BD_CLIENT_NAME ?? d.clientName,
    bs:       (d.BD_BUY_SELL ?? d.buyOrSell ?? "").toUpperCase(),
    qty:      parseInt(d.BD_QTY_TRD ?? d.quantity ?? 0, 10),
    price:    parseFloat(d.BD_TP_WATP ?? d.tradePrice ?? 0),
  })).filter((d) => d.symbol && d.bs);
}

async function fetchBlockDeals() {
  const to   = new Date();
  const from = new Date(); from.setDate(to.getDate() - 7);
  const url  = `${BASE}/api/historical/cm/block?from=${encodeURIComponent(ddmmyyyy(from))}&to=${encodeURIComponent(ddmmyyyy(to))}`;
  const j    = await fetchJson(url, BASE + "/market-data/block-deals");
  return (j.data ?? []).map((d) => ({
    date:     d.BD_DT_DATE ?? d.date,
    symbol:   d.BD_SYMBOL ?? d.symbol,
    client:   d.BD_CLIENT_NAME ?? d.clientName,
    bs:       (d.BD_BUY_SELL ?? d.buyOrSell ?? "").toUpperCase(),
    qty:      parseInt(d.BD_QTY_TRD ?? d.quantity ?? 0, 10),
    price:    parseFloat(d.BD_TP_WATP ?? d.tradePrice ?? 0),
  })).filter((d) => d.symbol && d.bs);
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
  if (!force) {
    const c = loadCache();
    if (c && Date.now() - new Date(c.fetchedAt).getTime() < CACHE_TTL) return c;
  }

  // Run each fetch independently — any failure becomes an empty list rather
  // than failing the whole pipeline.
  const safe = async (fn, fallback = []) => {
    try { return await fn(); } catch (e) { console.warn(`  ⚠ ${fn.name}: ${e.message}`); return fallback; }
  };

  // Run lightweight feeds in parallel, then sequentially hit bulk/block which
  // NSE rate-limits more aggressively.
  const [highs52w, lows52w, topGainers, topLosers, mostActiveVol, oiBuildup] = await Promise.all([
    safe(fetch52wHighs),
    safe(fetch52wLows),
    safe(() => fetchGainersLosers("gainers")),
    safe(() => fetchGainersLosers("losers")),
    safe(fetchMostActive),
    safe(fetchOiBuildup, { longBuildup: [], shortBuildup: [], shortCovering: [], longUnwinding: [] }),
  ]);
  // Sequential for bulk/block with a small spacer
  const bulkDeals  = await safe(fetchBulkDeals);
  await new Promise((r) => setTimeout(r, 1500));
  const blockDeals = await safe(fetchBlockDeals);

  const out = {
    fetchedAt: new Date().toISOString(),
    highs52w, lows52w, topGainers, topLosers,
    mostActiveVol, bulkDeals, blockDeals, oiBuildup,
  };
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
