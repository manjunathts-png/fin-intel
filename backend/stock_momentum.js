"use strict";

/**
 * Stock Momentum Radar
 *
 * Fetches daily price history for a curated universe of NSE stocks via
 * yahoo-finance2 and computes per-sector leaderboards: median returns over
 * 1W/1M/3M/6M/1Y plus a 1-week z-score (current 1W return vs trailing
 * 90-day weekly distribution).
 *
 * Caches:
 *   - stock_history_cache.json  — per-symbol price history (24h TTL)
 *   - in-memory leaderboard     — built once per hour
 */

const fs   = require("fs");
const path = require("path");
const YahooFinance = require("yahoo-finance2").default;
const { STOCK_SECTORS } = require("./stock_universe");

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

function atomicWrite(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

const CACHE_FILE      = path.join(__dirname, "stock_history_cache.json");
const HISTORY_DAYS    = 400;
const SYMBOL_TTL      = 24 * 60 * 60 * 1000;
const LEADERBOARD_TTL = 60 * 60 * 1000;

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
    atomicWrite(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    console.error("stock_history_cache.json save failed:", e.message);
  }
}

// ─── Price history ─────────────────────────────────────────────────────────────

async function fetchSymbolHistory(symbol) {
  const cached = cache.symbols[symbol];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < SYMBOL_TTL) {
    return cached;
  }

  const period1 = new Date();
  period1.setDate(period1.getDate() - HISTORY_DAYS);

  const data = await yahooFinance.chart(symbol, {
    period1: Math.floor(period1.getTime() / 1000),
    interval: "1d",
  });

  const quotes = data && data.quotes;
  if (!quotes || quotes.length === 0) {
    throw new Error(`No price history returned for ${symbol}`);
  }

  const prices = quotes
    .filter((d) => d.close != null && d.close > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((d) => ({
      date:  new Date(d.date).toISOString().slice(0, 10),
      close: d.close,
    }));

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

module.exports = { getStockLeaderboard };
