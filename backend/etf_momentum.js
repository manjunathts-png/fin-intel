"use strict";

/**
 * ETF Momentum Engine
 *
 * Hybrid module: combines NAV-based momentum (like MFs) with exchange data
 * (price, volume) and ETF-specific signals (premium/discount to NAV).
 *
 * Data sources per ETF:
 *   - mfapi.in (when scheme code present)  — daily NAV history
 *   - Yahoo Finance (ticker .NS)           — OHLC + daily volume
 *
 * Stats computed:
 *   - Standard windows on NAV  (ret1w/1m/3m/6m/1y)
 *   - z1w (current 1W return vs trailing 90-day weekly distribution)
 *   - premiumPct       (live price vs latest NAV)
 *   - avgDailyVolume   (20-day average ₹ volume)
 *
 * Output: { asOf, types: [{ type, etfs: [...] }], warnings }
 */

const fs   = require("fs");
const path = require("path");
const https = require("https");
const YahooFinance = require("yahoo-finance2").default;
const { ETF_TYPES, flatUniverse } = require("./etf_universe");
const { atomicWrite, daysAgo, mean, stddev, median, round2, sleep } = require("./utils");

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

const NAV_CACHE_FILE   = path.join(__dirname, "etf_nav_cache.json");
const PRICE_CACHE_FILE = path.join(__dirname, "etf_price_cache.json");
const HISTORY_DAYS  = 400;
const NAV_TTL       = 24 * 60 * 60 * 1000;
const PRICE_TTL     = 24 * 60 * 60 * 1000;
const LEADERBOARD_TTL = 60 * 60 * 1000;

const MFAPI_URL = (code) => `https://api.mfapi.in/mf/${code}`;

// ─── Cache I/O ────────────────────────────────────────────────────────────────

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`${file} read error:`, e.message);
  }
  return fallback;
}

let navCache   = loadJson(NAV_CACHE_FILE,   { schemes: {} });
let priceCache = loadJson(PRICE_CACHE_FILE, { tickers: {} });

function saveNavCache()   { try { atomicWrite(NAV_CACHE_FILE,   JSON.stringify(navCache));   } catch (e) {} }
function savePriceCache() { try { atomicWrite(PRICE_CACHE_FILE, JSON.stringify(priceCache)); } catch (e) {} }

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function httpsGet(url, { json = false, timeoutMs = 15000, _depth = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (_depth > 5) return reject(new Error(`too many redirects: ${url}`));
    const req = https.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(httpsGet(res.headers.location, { json, timeoutMs, _depth: _depth + 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(json ? JSON.parse(data) : data); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout: ${url}`)));
    req.on("error", reject);
  });
}

// ─── NAV history (mfapi.in) ────────────────────────────────────────────────────

async function fetchSchemeNav(code) {
  const cached = navCache.schemes[code];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < NAV_TTL) return cached;

  const data = await httpsGet(MFAPI_URL(code), { json: true });
  if (!data || !Array.isArray(data.data)) throw new Error(`bad mfapi response for ${code}`);

  const navs = data.data
    .map((d) => {
      const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d.date);
      if (!m) return null;
      return { date: `${m[3]}-${m[2]}-${m[1]}`, nav: parseFloat(d.nav) };
    })
    .filter((n) => n && !isNaN(n.nav) && n.nav > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-HISTORY_DAYS);

  const entry = {
    fetchedAt: new Date().toISOString(),
    name: data.meta && data.meta.scheme_name,
    navs,
  };
  navCache.schemes[code] = entry;
  saveNavCache();
  await sleep(50); // gentle rate limit: ~20 req/sec max toward mfapi.in
  return entry;
}

// ─── Price history (Yahoo) ─────────────────────────────────────────────────────

async function fetchTickerPrice(ticker) {
  const yahooSym = `${ticker}.NS`;
  const cached = priceCache.tickers[ticker];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < PRICE_TTL) return cached;

  const period1 = new Date();
  period1.setDate(period1.getDate() - HISTORY_DAYS);

  const data = await yahooFinance.chart(yahooSym, {
    period1: Math.floor(period1.getTime() / 1000),
    interval: "1d",
  });
  const quotes = data && data.quotes;
  if (!quotes || quotes.length === 0) throw new Error(`No price history for ${yahooSym}`);

  const prices = quotes
    .filter((d) => d.close != null && d.close > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((d) => ({
      date:   new Date(d.date).toISOString().slice(0, 10),
      close:  d.close,
      volume: d.volume ?? 0,
    }));

  const entry = { fetchedAt: new Date().toISOString(), prices };
  priceCache.tickers[ticker] = entry;
  savePriceCache();
  return entry;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function valAtOrBefore(series, targetDate, key = "nav") {
  if (series.length === 0) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (series[mid].date <= targetDate) lo = mid;
    else hi = mid - 1;
  }
  return series[lo].date <= targetDate ? series[lo][key] : null;
}

function pctReturn(series, days, key = "nav") {
  if (series.length === 0) return null;
  const latest = series[series.length - 1][key];
  const past = valAtOrBefore(series, daysAgo(days), key);
  if (past == null || past <= 0) return null;
  return ((latest - past) / past) * 100;
}

function rollingWeeklyReturns(series, lookbackDays = 90, key = "nav") {
  const out = [];
  for (let off = lookbackDays; off >= 7; off -= 7) {
    const past = valAtOrBefore(series, daysAgo(off),     key);
    const cur  = valAtOrBefore(series, daysAgo(off - 7), key);
    if (past == null || cur == null || past <= 0) continue;
    out.push(((cur - past) / past) * 100);
  }
  return out;
}

function computeStats(series, key) {
  const ret1w = pctReturn(series, 7,   key);
  const ret1m = pctReturn(series, 30,  key);
  const ret3m = pctReturn(series, 90,  key);
  const ret6m = pctReturn(series, 180, key);
  const ret1y = pctReturn(series, 365, key);
  const weekly = rollingWeeklyReturns(series, 90, key);
  const wStd = stddev(weekly);
  const wMean = mean(weekly);
  const z1w = ret1w != null && wStd > 0 ? (ret1w - wMean) / wStd : null;

  return {
    ret1w: round2(ret1w), ret1m: round2(ret1m), ret3m: round2(ret3m),
    ret6m: round2(ret6m), ret1y: round2(ret1y), z1w: round2(z1w),
  };
}

function typeAggregate(etfs) {
  const pick = (k) => etfs.map((e) => e[k]).filter((v) => v != null);
  return {
    ret1w: round2(median(pick("ret1w"))),
    ret1m: round2(median(pick("ret1m"))),
    ret3m: round2(median(pick("ret3m"))),
    ret6m: round2(median(pick("ret6m"))),
    ret1y: round2(median(pick("ret1y"))),
    z1w:   round2(median(pick("z1w"))),
  };
}

// ─── ETF-specific signals ─────────────────────────────────────────────────────

function premiumToNav(latestPrice, latestNav) {
  if (latestPrice == null || latestNav == null || latestNav <= 0) return null;
  return ((latestPrice - latestNav) / latestNav) * 100;
}

function avgDailyVolumeInr(prices, days = 20) {
  if (prices.length < days) return null;
  const tail = prices.slice(-days);
  const totals = tail.map((p) => (p.close ?? 0) * (p.volume ?? 0));
  return Math.round(mean(totals));
}

// Liquidity gate — small ETFs get demoted but aren't dropped.
// minAumCr     — minimum AUM in ₹ Cr to be "investable"
// minVolumeInr — minimum 20D avg daily ₹ volume to be tradeable
function liquidityFlag({ aumCr, avgDailyVolumeInr }) {
  if (aumCr == null) return "unknown";
  if (aumCr < 100) return "tiny";
  if (avgDailyVolumeInr != null && avgDailyVolumeInr < 5_000_000) return "thin"; // <₹50L/day
  if (aumCr < 500) return "small";
  return "ok";
}

// ─── Build per-ETF entry ─────────────────────────────────────────────────────

async function buildEtfEntry(etf) {
  const out = {
    code:      etf.code,
    ticker:    etf.ticker,
    label:     etf.label,
    type:      etf.type,
    aumCr:     etf.aumCr,
    ter:       etf.ter,
    benchmark: etf.benchmark,
    warnings:  [],
  };

  // ── Primary: Yahoo Finance NSE price (always — price is the authoritative
  //    source for exchange-traded funds; real-time vs once-daily NAV)
  let priceSeries = null;
  try {
    const priceEntry = await fetchTickerPrice(etf.ticker);
    priceSeries = priceEntry.prices;
    const latest = priceSeries[priceSeries.length - 1];
    out.latestPrice     = latest?.close ?? null;
    out.latestPriceDate = latest?.date  ?? null;
  } catch (e) {
    out.warnings.push(`Price fetch failed: ${e.message}`);
  }

  // Momentum from price series
  if (priceSeries && priceSeries.length >= 30) {
    const momentumSeries = priceSeries.map((p) => ({ date: p.date, val: p.close }));
    const stats = computeStats(momentumSeries, "val");
    Object.assign(out, stats);
    out.momentumSource = "price";
  } else {
    out.warnings.push("No usable price series for momentum");
  }

  // ── Secondary (best-effort): mfapi.in NAV — used only for premium/discount
  //    calculation. Silently skipped if unavailable; not surfaced as a warning
  //    since NAV unavailability doesn't affect momentum quality.
  if (etf.code) {
    try {
      const navEntry = await fetchSchemeNav(etf.code);
      const navSeries = navEntry.navs;
      if (navEntry.name) out.name = navEntry.name;
      out.latestNav = navSeries[navSeries.length - 1]?.nav ?? null;
    } catch (_e) {
      // NAV fetch failure is non-critical — momentum still computed from price
      out.latestNav = null;
    }
  }

  // ETF-specific signals
  out.premiumPct      = premiumToNav(out.latestPrice, out.latestNav);
  out.avgDailyVolume  = priceSeries ? avgDailyVolumeInr(priceSeries) : null;
  out.liquidityFlag   = liquidityFlag({ aumCr: out.aumCr, avgDailyVolumeInr: out.avgDailyVolume });

  return out;
}

// ─── Build leaderboard ────────────────────────────────────────────────────────

async function buildLeaderboard() {
  const types = [];
  const warnings = [];

  for (const [typeName, etfList] of Object.entries(ETF_TYPES)) {
    const etfs = [];
    for (const etf of etfList) {
      try {
        const entry = await buildEtfEntry({ ...etf, type: typeName });
        etfs.push(entry);
        if (entry.warnings.length > 0) {
          warnings.push(...entry.warnings.map((w) => `${typeName} · ${etf.ticker}: ${w}`));
        }
      } catch (e) {
        warnings.push(`${typeName} · ${etf.ticker}: ${e.message}`);
      }
    }

    etfs.sort((a, b) => (b.ret1w ?? -Infinity) - (a.ret1w ?? -Infinity));

    types.push({
      type: typeName,
      etfCount: etfs.length,
      median: typeAggregate(etfs),
      etfs,
    });
  }

  // Hottest types first (by 1W z-score)
  types.sort((a, b) => (b.median.z1w ?? -Infinity) - (a.median.z1w ?? -Infinity));

  return {
    asOf: new Date().toISOString(),
    types,
    warnings,
  };
}

// ─── Public ───────────────────────────────────────────────────────────────────

let leaderboardCache = { built: 0, data: null };

async function getEtfLeaderboard({ force = false } = {}) {
  if (!force && leaderboardCache.data && Date.now() - leaderboardCache.built < LEADERBOARD_TTL) {
    return leaderboardCache.data;
  }
  const data = await buildLeaderboard();
  leaderboardCache = { built: Date.now(), data };
  return data;
}

module.exports = { getEtfLeaderboard, flatUniverse };
