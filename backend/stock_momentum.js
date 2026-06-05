"use strict";

/**
 * Stock Momentum Radar
 *
 * Fetches daily price history for a curated universe of NSE stocks and
 * computes per-sector leaderboards: median returns over 1W/1M/3M/6M/1Y
 * plus a 1-week z-score (current 1W return vs trailing 90-day weekly
 * distribution).
 *
 * Price source priority (Yahoo Finance is blocked on GitHub Actions IPs):
 *   1. Stooq  — free CSV, no auth, works on CI
 *   2. Yahoo Finance v8 REST  — fallback, may be blocked on shared IPs
 *
 * Caches:
 *   - stock_history_cache.json  — per-symbol price history (24h TTL)
 *   - in-memory leaderboard     — built once per hour
 */

const fs   = require("fs");
const path = require("path");
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
  } catch (e) {
    console.error("stock_history_cache.json save failed:", e.message);
  }
}

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

// ─── Price history with source fallback ──────────────────────────────────────

async function fetchSymbolHistory(symbol) {
  const cached = cache.symbols[symbol];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < SYMBOL_TTL) {
    return cached;
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - HISTORY_DAYS);

  let prices = await fetchFromStooq(symbol, startDate);

  if (!prices || prices.length === 0) {
    console.warn(`  [fallback] ${symbol}: trying Yahoo REST…`);
    prices = await fetchFromYahooRest(symbol, startDate);
  }

  if (!prices || prices.length === 0) {
    throw new Error(`No price history returned for ${symbol} (all sources failed)`);
  }

  const entry = { fetchedAt: new Date().toISOString(), prices };
  cache.symbols[symbol] = entry;
  saveCache();
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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
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

const mean   = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stddev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const median = (a) => {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round2 = (v) => (v == null || isNaN(v) ? null : parseFloat(v.toFixed(2)));

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

module.exports = { getStockLeaderboard, fetchSymbolHistory };
