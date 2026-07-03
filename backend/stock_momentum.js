"use strict";

/**
 * Stock Momentum Radar
 *
 * Fetches daily price history for a curated universe of NSE stocks and
 * computes per-sector leaderboards: median returns over 1W/1M/3M/6M/1Y
 * plus a 1-week z-score (current 1W return vs trailing 90-day weekly
 * distribution).
 *
 * Price source priority:
 *   1. Stooq          — free CSV, no auth; fails for many NSE symbols from CI
 *   2. NSE Bhavcopy   — nsearchives.nseindia.com daily settlement CSVs;
 *                        no cookies needed, works from GitHub Actions IPs;
 *                        one file = all NSE stocks for one day; fetched in bulk
 *   3. Yahoo REST     — last resort, rate-limits quickly at scale
 *
 * Caches:
 *   - stock_history_cache.json  — per-symbol price history (24h TTL)
 *   - in-memory leaderboard     — built once per hour
 */

const fs   = require("fs");
const path = require("path");
const { daysAgo, mean, stddev, median, round2 } = require("./utils");
const { STOCK_SECTORS } = require("./stock_universe");

const CACHE_FILE      = path.join(__dirname, "stock_history_cache.json");
const HISTORY_DAYS    = 400;
const SYMBOL_TTL      = 24 * 60 * 60 * 1000;
const LEADERBOARD_TTL = 60 * 60 * 1000;

const FETCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─── Cache I/O ────────────────────────────────────────────────────────────────

let cache = loadCache();

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (e) {
    console.error("stock_history_cache.json read error:", e.message);
  }
  return { symbols: {} };
}

function saveCache() {
  try {
    const tmp = CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE_FILE);
    cacheDirty = false;
    lastCacheSave = Date.now();
  } catch (e) {
    console.error("stock_history_cache.json save failed:", e.message);
  }
}

// The cache is tens of MB with a full universe; serialising it after every
// symbol fetch turns a 500-stock scan into 500 full-file writes. Throttle to
// one write per interval and flush whatever is still dirty at process exit.
let cacheDirty    = false;
let lastCacheSave = 0;
const CACHE_SAVE_INTERVAL_MS = 5000;

function saveCacheThrottled() {
  cacheDirty = true;
  if (Date.now() - lastCacheSave >= CACHE_SAVE_INTERVAL_MS) saveCache();
}

process.on("exit", () => { if (cacheDirty) saveCache(); });

// ─── Date helpers ─────────────────────────────────────────────────────────────

function yyyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

// ─── Source 1: Stooq (primary — works on GitHub Actions) ──────────────────────

async function fetchFromStooq(symbol, startDate) {
  const sym = symbol.replace(".NS", "").toLowerCase();
  const d1  = yyyymmdd(startDate);
  const d2  = yyyymmdd(new Date(Date.now() + 86400000)); // tomorrow
  const url = `https://stooq.com/q/d/l/?s=${sym}.ns&d1=${d1}&d2=${d2}&i=d`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": FETCH_UA },
      signal:  AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    // Stooq returns a short error string or HTML when the symbol is unknown
    if (text.length < 50 || !text.toLowerCase().startsWith("date") || text.includes("apikey")) {
      throw new Error(`no data (len=${text.length})`);
    }
    const lines   = text.trim().split(/\r?\n/);
    const headers = lines[0].toLowerCase().split(",");
    const iDate   = headers.indexOf("date");
    const iOpen   = headers.indexOf("open");
    const iHigh   = headers.indexOf("high");
    const iLow    = headers.indexOf("low");
    const iClose  = headers.indexOf("close");
    const iVol    = headers.indexOf("volume");
    if (iDate < 0 || iClose < 0) throw new Error("unexpected CSV header");

    const prices = [];
    for (let i = 1; i < lines.length; i++) {
      const cols  = lines[i].split(",");
      const close = parseFloat(cols[iClose]);
      if (!isFinite(close) || close <= 0) continue;
      prices.push({
        date:   cols[iDate]?.trim() ?? "",
        open:   parseFloat(cols[iOpen])  || close,
        high:   parseFloat(cols[iHigh])  || close,
        low:    parseFloat(cols[iLow])   || close,
        close,
        volume: parseInt(cols[iVol], 10) || 0,
      });
    }
    prices.sort((a, b) => a.date.localeCompare(b.date));
    if (prices.length === 0) throw new Error("empty after parsing");
    return prices;
  } catch (e) {
    console.warn(`  [stooq] ${symbol}: ${e.message}`);
    return null;
  }
}

// ─── Source 2: Yahoo Finance v8 REST (fallback) ───────────────────────────────

async function fetchFromYahooRest(symbol, startDate) {
  const period1 = Math.floor(startDate.getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  const params  = new URLSearchParams({ interval: "1d", period1, period2, events: "history" });
  for (const base of [
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com",
  ]) {
    const url = `${base}/v8/finance/chart/${symbol}?${params}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": FETCH_UA, "Accept": "application/json" },
        signal:  AbortSignal.timeout(20000),
      });
      if (res.status === 429) { console.warn(`  [yahoo] ${symbol}: 429 rate-limited`); break; }
      if (!res.ok) continue;
      const data   = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const timestamps = result.timestamp ?? [];
      const q          = result.indicators?.quote?.[0] ?? {};
      const adjCloses  = result.indicators?.adjclose?.[0]?.adjclose ?? [];
      const closes     = adjCloses.length ? adjCloses : (q.close ?? []);
      if (!timestamps.length || !closes.length) continue;
      const prices = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = closes[i];
        if (close == null || close <= 0) continue;
        prices.push({
          date:   new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          open:   q.open?.[i]   ?? close,
          high:   q.high?.[i]   ?? close,
          low:    q.low?.[i]    ?? close,
          close,
          volume: q.volume?.[i] ?? 0,
        });
      }
      prices.sort((a, b) => a.date.localeCompare(b.date));
      if (prices.length > 0) return prices;
    } catch (e) {
      console.warn(`  [yahoo] ${symbol} (${base.split("/")[2]}): ${e.message}`);
    }
  }
  return null;
}

// ─── Source 3: NSE Bhavcopy Archive (bulk, no cookies, works on CI) ─────────
//
// Downloads sec_bhavdata_full_DDMMYYYY.csv from nsearchives.nseindia.com.
// Each file contains OHLCV for every NSE EQ-series stock for one trading day.
// We fetch the last ~HISTORY_DAYS calendar-days of weekday files in parallel,
// parse them, and populate the in-memory + disk cache for all symbols at once.
// This runs as a lazy singleton so it only executes once per process.

const NSE_ARCH         = "https://nsearchives.nseindia.com/products/content";
const MAX_BHAV_PARALLEL = 20;

let bhavFillPromise  = null;   // singleton — Bhavcopy bulk fill runs at most once
let bhavFillComplete = false;  // true once fill has finished; skips Stooq after that

function isoFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ddmmyyyyBhav(d) {
  return `${String(d.getDate()).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}${d.getFullYear()}`;
}

function parseBhavDate(str) {
  // DATE1 column format: "05-JUN-2026"
  const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const p = (str ?? "").trim().split("-");
  if (p.length !== 3) return null;
  const mon = MONTHS[p[1].toUpperCase()];
  if (mon == null) return null;
  const yr = parseInt(p[2]), day = parseInt(p[0]);
  if (isNaN(yr) || isNaN(day)) return null;
  return `${yr}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function fetchOneBhavcopy(date) {
  const url = `${NSE_ARCH}/sec_bhavdata_full_${ddmmyyyyBhav(date)}.csv`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": FETCH_UA,
      "Accept":     "text/csv,text/plain,*/*",
      "Referer":    "https://www.nseindia.com/",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

function parseOneBhavcopy(csv) {
  const lines  = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return {};
  const header = lines[0].split(",").map((h) => h.trim());
  const iSym   = header.indexOf("SYMBOL");
  const iSer   = header.indexOf("SERIES");
  const iDate  = header.indexOf("DATE1");
  const iOpen  = header.indexOf("OPEN_PRICE");
  const iHigh  = header.indexOf("HIGH_PRICE");
  const iLow   = header.indexOf("LOW_PRICE");
  const iClose = header.indexOf("CLOSE_PRICE");
  const iVol   = header.indexOf("TTL_TRD_QNTY");
  if (iSym < 0 || iClose < 0 || iDate < 0) return {};
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const ser  = cols[iSer] ?? "";
    if (ser !== "EQ" && ser !== "BE") continue;
    const sym   = cols[iSym];
    if (!sym) continue;
    const close = parseFloat(cols[iClose]);
    if (!isFinite(close) || close <= 0) continue;
    const date  = parseBhavDate(cols[iDate] ?? "");
    if (!date) continue;
    out[sym] = {
      date,
      open:   parseFloat(cols[iOpen])  || close,
      high:   parseFloat(cols[iHigh])  || close,
      low:    parseFloat(cols[iLow])   || close,
      close,
      volume: parseInt(cols[iVol], 10) || 0,
    };
  }
  return out;
}

async function bulkFillFromBhavcopies() {
  // Candidate weekday dates going back HISTORY_DAYS calendar days
  const candidateDates = [];
  for (let off = 1; off <= HISTORY_DAYS + 80; off++) {
    const d = new Date(); d.setDate(d.getDate() - off);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    candidateDates.push(d);
    if (candidateDates.length >= 310) break;  // ~310 weekdays covers 400 cal days
  }

  // Find dates already represented in any cached symbol (skip re-downloading them)
  const coveredDates = new Set();
  for (const entry of Object.values(cache.symbols)) {
    for (const p of (entry.prices ?? [])) coveredDates.add(p.date);
  }

  const datesToFetch = candidateDates.filter((d) => !coveredDates.has(isoFromDate(d)));

  if (datesToFetch.length === 0) {
    console.log("  [bhavcopy] cache already covers all dates — skipping bulk download");
    return;
  }

  console.log(`  [bhavcopy] downloading ${datesToFetch.length} trading days from NSE archive (${MAX_BHAV_PARALLEL} parallel)…`);

  // accumulated[baseSymbol] = [{date, open, high, low, close, volume}, ...]
  const accumulated = {};
  let downloaded = 0;

  for (let i = 0; i < datesToFetch.length; i += MAX_BHAV_PARALLEL) {
    const batch = datesToFetch.slice(i, i + MAX_BHAV_PARALLEL);
    await Promise.all(batch.map(async (d) => {
      try {
        const csv  = await fetchOneBhavcopy(d);
        const rows = parseOneBhavcopy(csv);
        for (const [sym, row] of Object.entries(rows)) {
          if (!accumulated[sym]) accumulated[sym] = [];
          accumulated[sym].push(row);
        }
        downloaded++;
      } catch {
        // 404 = market holiday; network error = transient — both safe to skip
      }
    }));
  }

  if (downloaded === 0) {
    console.warn("  [bhavcopy] WARNING: 0 files downloaded — NSE archive may be unreachable");
    return;
  }
  console.log(`  [bhavcopy] downloaded ${downloaded}/${datesToFetch.length} files`);

  // Merge into in-memory cache (preserving any fresh Stooq/Yahoo entries)
  const fetchedAt = new Date().toISOString();
  let filled = 0;
  for (const [base, rows] of Object.entries(accumulated)) {
    const nsSym    = base + ".NS";
    const existing = cache.symbols[nsSym];
    // Don't overwrite a very fresh entry from Stooq/Yahoo
    if (existing && (Date.now() - new Date(existing.fetchedAt).getTime()) < SYMBOL_TTL / 4) continue;
    // Merge existing prices with newly downloaded, dedup by date, sort, trim
    const merged = [
      ...(existing?.prices ?? []),
      ...rows,
    ];
    const deduped = [...new Map(merged.map((r) => [r.date, r])).values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-HISTORY_DAYS);
    if (deduped.length >= 20) {
      cache.symbols[nsSym] = { fetchedAt, prices: deduped };
      filled++;
    }
  }

  saveCache();
  bhavFillComplete = true;
  console.log(`  [bhavcopy] cache populated: ${filled} symbols`);
}

// Call before the per-symbol scan to pre-fill OHLCV for all symbols at once.
async function prewarmBhavOHLCV() {
  if (!bhavFillPromise) bhavFillPromise = bulkFillFromBhavcopies();
  await bhavFillPromise;
}

// ─── Price history with source fallback ──────────────────────────────────────

async function fetchSymbolHistory(symbol) {
  const cached = cache.symbols[symbol];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < SYMBOL_TTL) {
    return cached;
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - HISTORY_DAYS);

  // Only try Stooq when Bhavcopy hasn't run yet — if it failed for one symbol
  // it will fail for all, so skip it entirely once the bulk fill is done.
  if (!bhavFillComplete) {
    const stooqPrices = await fetchFromStooq(symbol, startDate);
    if (stooqPrices?.length > 0) {
      const entry = { fetchedAt: new Date().toISOString(), prices: stooqPrices };
      cache.symbols[symbol] = entry;
      saveCacheThrottled();
      return entry;
    }
    // Stooq failed — trigger Bhavcopy bulk fill (singleton)
    if (!bhavFillPromise) bhavFillPromise = bulkFillFromBhavcopies();
    await bhavFillPromise;
  }

  // Check cache after Bhavcopy fill (or if fill already ran)
  const afterFill = cache.symbols[symbol];
  if (afterFill?.prices?.length > 0) return afterFill;

  // Last resort: Yahoo REST (rate-limits quickly at scale, but catches stragglers)
  console.warn(`  [fallback] ${symbol}: trying Yahoo REST…`);
  const prices = await fetchFromYahooRest(symbol, startDate);

  if (!prices || prices.length === 0) {
    throw new Error(`No price history returned for ${symbol} (all sources failed)`);
  }

  const entry = { fetchedAt: new Date().toISOString(), prices };
  cache.symbols[symbol] = entry;
  saveCacheThrottled();
  return entry;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function priceAtOrBefore(prices, targetDate) {
  if (prices.length === 0) return null;
  let lo = 0, hi = prices.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (prices[mid].date <= targetDate) lo = mid;
    else hi = mid - 1;
  }
  return prices[lo].date <= targetDate ? prices[lo].close : null;
}

function pctReturn(prices, days) {
  if (prices.length === 0) return null;
  const latest = prices[prices.length - 1].close;
  const past   = priceAtOrBefore(prices, daysAgo(days));
  if (past == null || past <= 0) return null;
  return ((latest - past) / past) * 100;
}

function rollingWeeklyReturns(prices, lookbackDays = 90) {
  const out = [];
  for (let off = lookbackDays; off >= 7; off -= 7) {
    const past = priceAtOrBefore(prices, daysAgo(off));
    const cur  = priceAtOrBefore(prices, daysAgo(off - 7));
    if (past == null || cur == null || past <= 0) continue;
    out.push(((cur - past) / past) * 100);
  }
  return out;
}

function computeStockStats(prices) {
  const ret1w = pctReturn(prices, 7);
  const ret1m = pctReturn(prices, 30);
  const ret3m = pctReturn(prices, 90);
  const ret6m = pctReturn(prices, 180);
  const ret1y = pctReturn(prices, 365);

  const weekly = rollingWeeklyReturns(prices, 90);
  const wStd   = stddev(weekly);
  const wMean  = mean(weekly);
  const z1w    = ret1w != null && wStd > 0 ? (ret1w - wMean) / wStd : null;

  return {
    ret1w: round2(ret1w),
    ret1m: round2(ret1m),
    ret3m: round2(ret3m),
    ret6m: round2(ret6m),
    ret1y: round2(ret1y),
    z1w:   round2(z1w),
  };
}

function sectorAggregate(stocks) {
  const pick = (k) => stocks.map((s) => s[k]).filter((v) => v != null);
  return {
    ret1w: round2(median(pick("ret1w"))),
    ret1m: round2(median(pick("ret1m"))),
    ret3m: round2(median(pick("ret3m"))),
    ret6m: round2(median(pick("ret6m"))),
    ret1y: round2(median(pick("ret1y"))),
    z1w:   round2(median(pick("z1w"))),
  };
}

// ─── Build leaderboard ────────────────────────────────────────────────────────

async function buildLeaderboard() {
  const sectors  = [];
  const warnings = [];

  for (const [sectorName, stockEntries] of Object.entries(STOCK_SECTORS)) {
    const stocks = [];

    for (const { symbol, label } of stockEntries) {
      try {
        const entry  = await fetchSymbolHistory(symbol);
        const stats  = computeStockStats(entry.prices);
        const latest = entry.prices[entry.prices.length - 1];
        stocks.push({
          symbol,
          label,
          price: latest ? round2(latest.close) : null,
          ...stats,
        });
      } catch (e) {
        warnings.push(`${symbol} (${label}): ${e.message}`);
      }
    }

    stocks.sort((a, b) => (b.ret1w ?? -Infinity) - (a.ret1w ?? -Infinity));

    sectors.push({
      sector:     sectorName,
      stockCount: stocks.length,
      median:     sectorAggregate(stocks),
      stocks,
    });
  }

  // Hottest sectors first by 1W z-score
  sectors.sort((a, b) => (b.median.z1w ?? -Infinity) - (a.median.z1w ?? -Infinity));

  return { asOf: new Date().toISOString(), sectors, warnings };
}

// ─── Public ───────────────────────────────────────────────────────────────────

let leaderboardCache = { built: 0, data: null };

async function getStockLeaderboard({ force = false } = {}) {
  if (!force && leaderboardCache.data && Date.now() - leaderboardCache.built < LEADERBOARD_TTL) {
    return leaderboardCache.data;
  }
  const data = await buildLeaderboard();
  leaderboardCache = { built: Date.now(), data };
  return data;
}

module.exports = { getStockLeaderboard, fetchSymbolHistory, prewarmBhavOHLCV };
