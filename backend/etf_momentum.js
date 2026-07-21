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
const { ETF_TYPES, flatUniverse } = require("./etf_universe");
const { atomicWrite, daysAgo, mean, stddev, median, round2, sleep } = require("./utils");
const { getCachedPrices } = require("./stock_momentum");

const FETCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const NAV_CACHE_FILE   = path.join(__dirname, "etf_nav_cache.json");
const PRICE_CACHE_FILE = path.join(__dirname, "etf_price_cache.json");
const HISTORY_DAYS  = 400;
const NAV_TTL       = 24 * 60 * 60 * 1000;
const PRICE_TTL     = 24 * 60 * 60 * 1000;
const LEADERBOARD_TTL = 60 * 60 * 1000;

// Momentum computation guards — see buildEtfEntry.
const MIN_PRICE_ROWS       = 2;   // bare minimum for any pctReturn to have a chance
const MAX_STALE_PRICE_DAYS = 10;  // don't treat a long-quiet ticker's old print as "now"
const PRICE_FETCH_THROTTLE_MS = 200; // gentle pacing toward Stooq/Yahoo — see fetchTickerPrice

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

// ─── Price history (Stooq primary, Yahoo fallback) ─────────────────────────────

function yyyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchFromStooq(ticker, startDate) {
  const sym = ticker.toLowerCase();
  const d1  = yyyymmdd(startDate);
  const d2  = yyyymmdd(new Date(Date.now() + 86400000));
  const url = `https://stooq.com/q/d/l/?s=${sym}.ns&d1=${d1}&d2=${d2}&i=d`;
  const res = await fetch(url, {
    headers: { "User-Agent": FETCH_UA },
    signal:  AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from stooq`);
  const text = await res.text();
  if (text.length < 50 || !text.toLowerCase().startsWith("date") || text.includes("apikey")) {
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 80) || "(empty body)";
    throw new Error(`no data from stooq (len=${text.length}): ${snippet}`);
  }
  const lines   = text.trim().split(/\r?\n/);
  const headers = lines[0].toLowerCase().split(",");
  const iDate   = headers.indexOf("date");
  const iClose  = headers.indexOf("close");
  const iVol    = headers.indexOf("volume");
  if (iDate < 0 || iClose < 0) throw new Error("unexpected stooq CSV header");

  const prices = [];
  for (let i = 1; i < lines.length; i++) {
    const cols  = lines[i].split(",");
    const close = parseFloat(cols[iClose]);
    if (!isFinite(close) || close <= 0) continue;
    prices.push({ date: cols[iDate]?.trim() ?? "", close, volume: parseInt(cols[iVol], 10) || 0 });
  }
  prices.sort((a, b) => a.date.localeCompare(b.date));
  if (prices.length === 0) throw new Error("empty after parsing stooq CSV");
  return prices;
}

// Raw REST fetch (query1/query2 dual-host, no schema validation) — the same
// pattern already proven in stock_momentum.js and nifty_benchmark.js. This
// module used to call the yahoo-finance2 npm package's .chart() here, which
// has a documented history of throwing on schema drift for some tickers
// (2026-07-03 incident: it zeroed out etf_picks entirely). A raw fetch with
// defensive ?./?? access can only succeed in more cases than a
// schema-validating library call for the same underlying data.
async function fetchFromYahoo(ticker, startDate) {
  const yahooSym = `${ticker}.NS`;
  const period1   = Math.floor(startDate.getTime() / 1000);
  const period2   = Math.floor(Date.now() / 1000) + 86400;
  const params    = new URLSearchParams({ interval: "1d", period1, period2, events: "history" });

  for (const base of [
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com",
  ]) {
    const url = `${base}/v8/finance/chart/${yahooSym}?${params}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": FETCH_UA, "Accept": "application/json" },
        signal:  AbortSignal.timeout(20000),
      });
      if (res.status === 429) { console.warn(`  [yahoo] ${yahooSym}: 429 rate-limited`); break; }
      if (!res.ok) continue;
      const data   = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const timestamps = result.timestamp ?? [];
      const q          = result.indicators?.quote?.[0] ?? {};
      const adjCloses   = result.indicators?.adjclose?.[0]?.adjclose ?? [];
      const closes      = adjCloses.length ? adjCloses : (q.close ?? []);
      if (!timestamps.length || !closes.length) continue;
      const prices = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = closes[i];
        if (close == null || close <= 0) continue;
        prices.push({
          date:   new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          close,
          volume: q.volume?.[i] ?? 0,
        });
      }
      prices.sort((a, b) => a.date.localeCompare(b.date));
      if (prices.length > 0) return prices;
    } catch (e) {
      console.warn(`  [yahoo] ${yahooSym} (${base.split("/")[2]}): ${e.message}`);
    }
  }
  throw new Error(`No price history for ${yahooSym} (query1 and query2 both failed)`);
}

async function fetchTickerPrice(ticker) {
  const cached = priceCache.tickers[ticker];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < PRICE_TTL) return cached;

  // Bhavcopy first, no network call at all: the stock pipeline already
  // bulk-downloads NSE's daily settlement archive (nsearchives.nseindia.com)
  // for every EQ/BE-series symbol, which includes ETFs — they trade on the
  // same cash segment under the same series codes. That archive has no bot-
  // blocking and is proven reliable from GitHub Actions IPs (stock_momentum.js
  // has used it for stocks since the Stooq/Yahoo problems started).
  //
  // Escalated to this after throttling (2026-07-20) turned out not to be
  // enough: on 2026-07-21, hours later and across multiple separate job
  // runs (fresh runners, presumably different IPs), Stooq AND Yahoo both
  // still failed for all 36 ETFs — not a short burst, something more
  // persistent (very likely Yahoo rate-limiting GitHub's shared runner IP
  // pool in general, unrelated to this repo's request rate). No amount of
  // pacing a single job's requests fixes a limit that outlives the job.
  const bhavPrices = getCachedPrices(`${ticker}.NS`);
  if (bhavPrices && bhavPrices.length > 0) {
    const prices = bhavPrices.map((p) => ({ date: p.date, close: p.close, volume: p.volume ?? 0 }));
    const entry = { fetchedAt: new Date().toISOString(), prices, source: "bhavcopy" };
    priceCache.tickers[ticker] = entry;
    savePriceCache();
    return entry;
  }

  const period1 = new Date();
  period1.setDate(period1.getDate() - HISTORY_DAYS);

  let prices;
  try {
    prices = await fetchFromStooq(ticker, period1);
  } catch (e) {
    console.warn(`  [stooq] ${ticker}: ${e.message} — falling back to Yahoo`);
    prices = await fetchFromYahoo(ticker, period1);
  }

  const entry = { fetchedAt: new Date().toISOString(), prices };
  priceCache.tickers[ticker] = entry;
  savePriceCache();
  // Gentle rate limit toward Stooq/Yahoo, mirroring fetchSchemeNav's courtesy
  // delay toward mfapi.in. Kept even after the bhavcopy fix above, since
  // any ETF bhavcopy doesn't cover still falls through to these two.
  await sleep(PRICE_FETCH_THROTTLE_MS);
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

// ─── Momentum decision (pure — unit tested) ──────────────────────────────────
//
// Each horizon in computeStats already degrades gracefully on its own —
// pctReturn returns null for a horizon it doesn't have data far enough back
// for, same as the MF momentum path (momentum.js computeFundStats has no
// blanket length gate at all). This used to require >=30 total rows before
// computing ANYTHING, which meant a handful of genuinely thin-traded ETFs
// (e.g. small gold ETFs that print on only a few days a month) showed every
// single horizon as null even when a real 1W/1M return was computable from
// the rows they do have.
//
// The one real risk in going lower is staleness, not sparsity: pctReturn
// treats the series' LAST row as "now" regardless of its actual date. For a
// ticker that hasn't traded in weeks, that would fabricate a flat ~0% return
// instead of honestly reporting "no recent data" — so gate on how old the
// latest print actually is, not on how many rows came before it.
function momentumFromPrices(priceSeries, nowMs = Date.now()) {
  if (!priceSeries || priceSeries.length < MIN_PRICE_ROWS) {
    return { stats: null, momentumSource: null, warning: `No usable price series for momentum (${priceSeries?.length ?? 0} rows)` };
  }
  const latestDate = priceSeries[priceSeries.length - 1].date;
  const staleDays   = (nowMs - new Date(latestDate + "T00:00:00Z").getTime()) / 86400000;
  if (staleDays > MAX_STALE_PRICE_DAYS) {
    return { stats: null, momentumSource: null, warning: `Latest price is ${Math.round(staleDays)}d old (${latestDate}) — too stale to use as "now"` };
  }
  const momentumSeries = priceSeries.map((p) => ({ date: p.date, val: p.close }));
  const stats = computeStats(momentumSeries, "val");
  const warning = priceSeries.length < 30
    ? `Thin price history (${priceSeries.length} rows) — long-horizon returns may be null`
    : null;
  return { stats, momentumSource: "price", warning };
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

  // Momentum from price series (pure decision logic in momentumFromPrices —
  // see its doc comment for why the old >=30-rows gate was replaced).
  const momentum = momentumFromPrices(priceSeries);
  if (momentum.stats) Object.assign(out, momentum.stats);
  if (momentum.momentumSource) out.momentumSource = momentum.momentumSource;
  if (momentum.warning) out.warnings.push(momentum.warning);

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

module.exports = {
  getEtfLeaderboard, flatUniverse, momentumFromPrices, fetchTickerPrice,
  _config: { MIN_PRICE_ROWS, MAX_STALE_PRICE_DAYS, PRICE_FETCH_THROTTLE_MS },
};
