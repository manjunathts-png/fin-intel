"use strict";

/**
 * MF Momentum Radar
 *
 * Pulls daily NAV history for a curated universe of funds and computes
 * per-category leaderboards: median returns over 1W/1M/3M/6M/1Y plus a
 * 1-week z-score (current 1W return vs trailing 90-day weekly distribution).
 *
 * Data sources:
 *   - AMFI NAVAll.txt           — to resolve fund-name → scheme-code
 *   - api.mfapi.in/mf/<code>    — for full NAV history per scheme
 *
 * Caches:
 *   - mf_history_cache.json     — AMFI list (24h) + per-scheme NAV history (24h)
 *   - in-memory leaderboard     — built once per hour
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { atomicWrite, daysAgo, mean, stddev, median, round2, sleep } = require("./utils");
const { CATEGORIES: STATIC_CATEGORIES } = require("./mf_universe");
const { getDynamicMfCategories } = require("./amfi_discovery");

const CACHE_FILE   = path.join(__dirname, "mf_history_cache.json");
const AMFI_URL     = "https://www.amfiindia.com/spages/NAVAll.txt";
const MFAPI_URL    = (code) => `https://api.mfapi.in/mf/${code}`;
const AMFI_HIST_URL = (code, from, to) =>
  `https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=${from}&todt=${to}&SchId=${code}`;
// Keep up to ~15 years of NAV history. mfapi.in returns full lifetime (often
// 20+ years for older schemes) — we cap at 15Y * 365 = 5475 days to keep the
// cache file size sane while still supporting 10Y CAGR with margin.
const NAV_HISTORY_DAYS = 5475;
const SCHEME_TTL = 24 * 60 * 60 * 1000;
const AMFI_TTL = 24 * 60 * 60 * 1000;
const LEADERBOARD_TTL = 60 * 60 * 1000;
const RISK_FREE_RATE = 7; // India 10Y G-Sec proxy (% annual)
// AMFI publishes NAV every business day; a longer gap than this usually
// means a broken/stale feed for that scheme, not a normal weekend. Guards
// the same risk as etf_momentum.js's MAX_STALE_PRICE_DAYS: pctReturn treats
// the series' last entry as "now" regardless of its actual date, so a stale
// latest NAV would otherwise fabricate a flat ~0% short-horizon return.
const MAX_STALE_NAV_DAYS = 10;

// ─── Cache I/O ────────────────────────────────────────────────────────────────

let cache = loadCache();

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (e) {
    console.error("mf_history_cache.json read error:", e.message);
  }
  return { amfi: null, schemes: {} };
}

function saveCache() {
  try {
    atomicWrite(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    console.error("mf_history_cache.json save failed:", e.message);
  }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function httpsGet(url, { json = false, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      // Follow simple 301/302 redirects (mfapi sometimes 301s)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(httpsGet(res.headers.location, { json, timeoutMs }));
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
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`));
    });
    req.on("error", reject);
  });
}

// ─── AMFI scheme list ─────────────────────────────────────────────────────────

async function getAmfiList() {
  if (cache.amfi && Date.now() - new Date(cache.amfi.fetchedAt).getTime() < AMFI_TTL) {
    return cache.amfi.list;
  }
  const text = await httpsGet(AMFI_URL);
  const list = {};
  for (const line of text.split("\n")) {
    const parts = line.split(";");
    if (parts.length < 6) continue;
    const code = parts[0].trim();
    if (!/^\d+$/.test(code)) continue;
    const name = parts[3].trim();
    const nav = parseFloat(parts[4]);
    list[code] = { name, nav: isNaN(nav) ? null : nav };
  }
  cache.amfi = { fetchedAt: new Date().toISOString(), list };
  saveCache();
  return list;
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Best-effort fuzzy match: exact normalized → substring → all-words-present. */
function findSchemeCode(amfiList, queryName) {
  const target = normalize(queryName);
  const targetWords = target.split(" ").filter(Boolean);

  for (const [code, { name }] of Object.entries(amfiList)) {
    if (normalize(name) === target) return code;
  }
  for (const [code, { name }] of Object.entries(amfiList)) {
    if (normalize(name).includes(target)) return code;
  }
  let bestMatch = null;
  let bestScore = -Infinity;
  for (const [code, { name }] of Object.entries(amfiList)) {
    const norm = normalize(name);
    if (!targetWords.every((w) => norm.includes(w))) continue;
    // Prefer shorter names (fewer extraneous tokens)
    const score = -Math.abs(norm.length - target.length);
    if (score > bestScore) { bestScore = score; bestMatch = code; }
  }
  return bestMatch;
}

// ─── AMFI portal direct NAV history (last-resort fallback) ───────────────────

function amfiFmtDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${dd}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

async function fetchSchemeHistoryFromAmfi(code) {
  const to   = new Date();
  const from = new Date();
  from.setDate(from.getDate() - NAV_HISTORY_DAYS);
  const url = AMFI_HIST_URL(code, amfiFmtDate(from), amfiFmtDate(to));
  const text = await httpsGet(url, { timeoutMs: 30000 });
  // Format: SchemeCode;ISIN1;ISIN2;SchemeName;NAV;Date (header on first line)
  const navs = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(";");
    if (parts.length < 6) continue;
    if (parts[0].trim() !== String(code)) continue;
    const navVal = parseFloat(parts[4]);
    const raw    = parts[5]?.trim() ?? "";
    // Date from AMFI portal: DD-Mon-YYYY
    const m = /^(\d{2})-(\w{3})-(\d{4})$/.exec(raw);
    if (!m || !isFinite(navVal) || navVal <= 0) continue;
    const months = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
                     jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
    const mo = months[m[2].toLowerCase()];
    if (!mo) continue;
    navs.push({ date: `${m[3]}-${mo}-${m[1]}`, nav: navVal });
  }
  navs.sort((a, b) => a.date.localeCompare(b.date));
  if (navs.length === 0) throw new Error(`AMFI portal returned no NAV data for ${code}`);
  return navs;
}

// ─── Scheme NAV history ───────────────────────────────────────────────────────

async function fetchSchemeHistory(code) {
  const cached = cache.schemes[code];
  const isFresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < SCHEME_TTL;
  if (isFresh) return cached;

  try {
    const data = await httpsGet(MFAPI_URL(code), { json: true });
    if (!data || !Array.isArray(data.data)) {
      throw new Error(`bad mfapi response for ${code}`);
    }
    // mfapi: { data: [{ date: "DD-MM-YYYY", nav: "100.00" }, ...] } — newest first
    const navs = data.data
      .map((d) => {
        const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d.date);
        if (!m) return null;
        return { date: `${m[3]}-${m[2]}-${m[1]}`, nav: parseFloat(d.nav) };
      })
      .filter((n) => n && !isNaN(n.nav) && n.nav > 0)
      .sort((a, b) => a.date.localeCompare(b.date)); // oldest first

    const trimmed = navs.slice(-NAV_HISTORY_DAYS);
    const entry = {
      fetchedAt: new Date().toISOString(),
      name: data.meta && data.meta.scheme_name,
      navs: trimmed,
    };
    cache.schemes[code] = entry;
    saveCache();
    await sleep(50); // gentle rate limit: ~20 req/sec max toward mfapi.in
    return entry;
  } catch (e) {
    // Stale-on-error: if mfapi.in is down but we have any cached data (even expired),
    // use it rather than dropping the fund entirely from the leaderboard.
    if (cached && cached.navs?.length > 0) {
      console.warn(`  [stale-ok] ${code}: mfapi failed (${e.message}) — using cached data from ${cached.fetchedAt.slice(0, 10)}`);
      return cached;
    }
    // Cold cache + mfapi.in down → try AMFI portal direct
    console.warn(`  [amfi-fallback] ${code}: mfapi failed, no cache — trying AMFI portal…`);
    try {
      const navs = await fetchSchemeHistoryFromAmfi(code);
      const entry = { fetchedAt: new Date().toISOString(), name: null, navs: navs.slice(-NAV_HISTORY_DAYS) };
      cache.schemes[code] = entry;
      saveCache();
      return entry;
    } catch (e2) {
      throw new Error(`${e.message}; AMFI fallback also failed: ${e2.message}`);
    }
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function navAtOrBefore(navs, targetDate) {
  if (navs.length === 0) return null;
  let lo = 0, hi = navs.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (navs[mid].date <= targetDate) lo = mid;
    else hi = mid - 1;
  }
  return navs[lo].date <= targetDate ? navs[lo].nav : null;
}

function pctReturn(navs, days) {
  if (navs.length === 0) return null;
  const latest = navs[navs.length - 1];
  const past = navAtOrBefore(navs, daysAgo(days));
  if (past == null || past <= 0) return null;
  return ((latest.nav - past) / past) * 100;
}

/** Non-overlapping weekly returns over the last `lookbackDays` days. */
function rollingWeeklyReturns(navs, lookbackDays = 90) {
  const out = [];
  for (let off = lookbackDays; off >= 7; off -= 7) {
    const past = navAtOrBefore(navs, daysAgo(off));
    const cur  = navAtOrBefore(navs, daysAgo(off - 7));
    if (past == null || cur == null || past <= 0) continue;
    out.push(((cur - past) / past) * 100);
  }
  return out;
}

// CAGR over `years` years from latest NAV
function cagr(navs, years) {
  if (navs.length === 0) return null;
  const latest = navs[navs.length - 1].nav;
  const past = navAtOrBefore(navs, daysAgo(years * 365));
  if (past == null || past <= 0) return null;
  return (Math.pow(latest / past, 1 / years) - 1) * 100;
}

// Monthly returns from daily NAVs (group by YYYY-MM, take last NAV of each month)
function monthlyReturns(navs) {
  if (navs.length === 0) return [];
  const byMonth = new Map();
  for (const { date, nav } of navs) {
    const key = date.slice(0, 7); // YYYY-MM
    byMonth.set(key, nav); // overwrites — keeps last (latest in chronological order)
  }
  const sorted = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
  const rets = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1][1], cur = sorted[i][1];
    if (prev > 0) rets.push((cur - prev) / prev);
  }
  return rets;
}

// Drawdown analysis — returns { maxDd, currentDd }
function drawdown(navs) {
  if (navs.length === 0) return { maxDd: null, currentDd: null };
  let peak = navs[0].nav, maxDd = 0;
  for (const { nav } of navs) {
    if (nav > peak) peak = nav;
    const dd = peak > 0 ? (nav / peak - 1) * 100 : 0;
    if (dd < maxDd) maxDd = dd;
  }
  const lastPeak = navs.reduce((p, n) => n.nav > p ? n.nav : p, 0);
  const last = navs[navs.length - 1].nav;
  const currentDd = lastPeak > 0 ? (last / lastPeak - 1) * 100 : null;
  return { maxDd, currentDd };
}

// Sharpe & Sortino & Calmar from monthly returns
function riskMetrics(mRets, annualReturn, maxDdPct) {
  if (!mRets.length || annualReturn == null) return { sharpe: null, sortino: null, calmar: null, volatility: null };
  const m = mean(mRets);
  const v = mean(mRets.map((r) => (r - m) ** 2));
  const monthlyStd = Math.sqrt(v);
  const annStd = monthlyStd * Math.sqrt(12) * 100;
  const rfMonthly = RISK_FREE_RATE / 100 / 12;
  const sharpe = annStd > 0 ? (annualReturn - RISK_FREE_RATE) / annStd : null;
  // Sortino: only downside variance
  const downside = mRets.filter((r) => r < rfMonthly);
  let sortino = null;
  if (downside.length) {
    const downVar = mean(downside.map((r) => (r - rfMonthly) ** 2));
    const annDown = Math.sqrt(downVar) * Math.sqrt(12) * 100;
    sortino = annDown > 0 ? (annualReturn - RISK_FREE_RATE) / annDown : null;
  }
  const calmar = maxDdPct != null && maxDdPct < 0 ? annualReturn / Math.abs(maxDdPct) : null;
  return { sharpe, sortino, calmar, volatility: annStd };
}

// Consistency: % of rolling 12M periods (monthly windows) where CAGR > 12%
function consistency(navs, thresholdPct = 12) {
  if (navs.length === 0) return null;
  // Build monthly NAV series
  const byMonth = new Map();
  for (const { date, nav } of navs) byMonth.set(date.slice(0, 7), nav);
  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (months.length < 13) return null;
  let total = 0, hits = 0;
  for (let i = 12; i < months.length; i++) {
    const start = months[i - 12][1], end = months[i][1];
    if (start > 0) {
      const ret = ((end / start) - 1) * 100;
      total += 1;
      if (ret >= thresholdPct) hits += 1;
    }
  }
  return total > 0 ? (hits / total) * 100 : null;
}

// Best / worst single month return (%)
function bestWorstMonth(mRets) {
  if (!mRets.length) return { best: null, worst: null };
  return { best: Math.max(...mRets) * 100, worst: Math.min(...mRets) * 100 };
}

// Pure — unit tested. Point-in-time returns (ret1w..ret1y, z1w) compare the
// LATEST nav to points further back; if that latest entry is stale, "now"
// isn't really now and the comparison would fabricate a misleading flat
// return. CAGR/drawdown/consistency look backward over the whole series and
// aren't materially distorted by a stale tail, so they're left unguarded.
function navFreshness(navs, nowMs = Date.now()) {
  const latestDate = navs[navs.length - 1]?.date ?? null;
  if (latestDate == null) return { fresh: false, staleDays: Infinity };
  const staleDays = (nowMs - new Date(latestDate + "T00:00:00Z").getTime()) / 86400000;
  return { fresh: staleDays <= MAX_STALE_NAV_DAYS, staleDays };
}

function computeFundStats(navs, nowMs = Date.now()) {
  const { fresh: navFresh, staleDays: navStaleDays } = navFreshness(navs, nowMs);

  const ret1w = navFresh ? pctReturn(navs, 7)   : null;
  const ret1m = navFresh ? pctReturn(navs, 30)  : null;
  const ret3m = navFresh ? pctReturn(navs, 90)  : null;
  const ret6m = navFresh ? pctReturn(navs, 180) : null;
  const ret1y = navFresh ? pctReturn(navs, 365) : null;

  const cagr3y  = cagr(navs, 3);
  const cagr5y  = cagr(navs, 5);
  const cagr10y = cagr(navs, 10);

  const weekly = navFresh ? rollingWeeklyReturns(navs, 90) : [];
  const wStd = stddev(weekly);
  const wMean = mean(weekly);
  const z1w = ret1w != null && wStd > 0 ? (ret1w - wMean) / wStd : null;

  // Long-horizon monthly returns over up to 5 years for stable risk metrics
  const navs5y = navs.filter((n) => n.date >= daysAgo(365 * 5));
  const mRets5y = monthlyReturns(navs5y);
  const dd5y = drawdown(navs5y);
  const annRetForRisk = cagr5y ?? cagr3y ?? ret1y; // fallback ladder
  const risk = riskMetrics(mRets5y, annRetForRisk, dd5y.maxDd);
  const bw = bestWorstMonth(mRets5y);

  // Drawdown over full available history (typically 10Y+)
  const ddFull = drawdown(navs);

  // Consistency uses full available history
  const consist = consistency(navs, 12);

  return {
    ret1w:        round2(ret1w),
    ret1m:        round2(ret1m),
    ret3m:        round2(ret3m),
    ret6m:        round2(ret6m),
    ret1y:        round2(ret1y),
    z1w:          round2(z1w),
    cagr3y:       round2(cagr3y),
    cagr5y:       round2(cagr5y),
    cagr10y:      round2(cagr10y),
    sharpe:       round2(risk.sharpe),
    sortino:      round2(risk.sortino),
    calmar:       round2(risk.calmar),
    volatility:   round2(risk.volatility),
    maxDd:        round2(dd5y.maxDd),
    maxDdFull:    round2(ddFull.maxDd),
    currentDd:    round2(dd5y.currentDd),
    consistency:  round2(consist),
    bestMonth:    round2(bw.best),
    worstMonth:   round2(bw.worst),
    navStartDate: navs[0]?.date ?? null,
    navCount:     navs.length,
    navStale:     !navFresh,
    navStaleDays: isFinite(navStaleDays) ? Math.round(navStaleDays) : null,
  };
}

function categoryAggregate(funds) {
  const pick = (k) => funds.map((f) => f[k]).filter((v) => v != null);
  return {
    ret1w:       round2(median(pick("ret1w"))),
    ret1m:       round2(median(pick("ret1m"))),
    ret3m:       round2(median(pick("ret3m"))),
    ret6m:       round2(median(pick("ret6m"))),
    ret1y:       round2(median(pick("ret1y"))),
    z1w:         round2(median(pick("z1w"))),
    cagr3y:      round2(median(pick("cagr3y"))),
    cagr5y:      round2(median(pick("cagr5y"))),
    cagr10y:     round2(median(pick("cagr10y"))),
    sharpe:      round2(median(pick("sharpe"))),
    sortino:     round2(median(pick("sortino"))),
    calmar:      round2(median(pick("calmar"))),
    volatility:  round2(median(pick("volatility"))),
    maxDd:       round2(median(pick("maxDd"))),
    consistency: round2(median(pick("consistency"))),
  };
}

// ─── Build leaderboard ────────────────────────────────────────────────────────

async function buildLeaderboard({ benchmarks = null } = {}) {
  // AMFI list is still fetched for latest NAV lookups; fund codes come from universe config
  let amfiList = {};
  try { amfiList = await getAmfiList(); } catch (e) {
    console.warn("AMFI list fetch failed (will skip latest NAV):", e.message);
  }

  // Expand static universe with AMFI-discovered funds (falls back to static on failure)
  const CATEGORIES = await getDynamicMfCategories(STATIC_CATEGORIES);

  const categories = [];
  const warnings = [];

  for (const [categoryName, fundEntries] of Object.entries(CATEGORIES)) {
    const funds = [];
    const bench = benchmarks?.byCategory?.[categoryName] ?? null;

    for (const fund of fundEntries) {
      const { code, label } = fund;
      try {
        const entry = await fetchSchemeHistory(code);
        const stats = computeFundStats(entry.navs);

        // Alpha vs benchmark (CAGR over same period)
        const alpha1y  = stats.ret1y   != null && bench?.ret1y   != null ? round2(stats.ret1y   - bench.ret1y)   : null;
        const alpha3y  = stats.cagr3y  != null && bench?.cagr3y  != null ? round2(stats.cagr3y  - bench.cagr3y)  : null;
        const alpha5y  = stats.cagr5y  != null && bench?.cagr5y  != null ? round2(stats.cagr5y  - bench.cagr5y)  : null;
        const alpha10y = stats.cagr10y != null && bench?.cagr10y != null ? round2(stats.cagr10y - bench.cagr10y) : null;

        funds.push({
          code,
          label,
          name: entry.name || amfiList[code]?.name || label,
          latestNav: amfiList[code]?.nav ?? null,
          ...stats,
          alpha1y, alpha3y, alpha5y, alpha10y,
          benchmarkSymbol: bench?.symbol ?? null,
          benchmarkLabel:  bench?.label  ?? null,
        });
      } catch (e) {
        warnings.push(`History fetch failed for ${code} (${label}): ${e.message}`);
      }
    }

    // Default sort by 5Y CAGR for long-term framing (fallback to 1Y return)
    funds.sort((a, b) => (b.cagr5y ?? b.ret1y ?? -Infinity) - (a.cagr5y ?? a.ret1y ?? -Infinity));

    // Category-level alpha medians
    const aggregate = categoryAggregate(funds);
    aggregate.alpha1y  = round2(median(funds.map((f) => f.alpha1y).filter((v) => v != null)));
    aggregate.alpha3y  = round2(median(funds.map((f) => f.alpha3y).filter((v) => v != null)));
    aggregate.alpha5y  = round2(median(funds.map((f) => f.alpha5y).filter((v) => v != null)));
    aggregate.alpha10y = round2(median(funds.map((f) => f.alpha10y).filter((v) => v != null)));

    if (funds.length > 0) {
      categories.push({
        category:  categoryName,
        benchmark: bench,
        fundCount: funds.length,
        median:    aggregate,
        funds,
      });
    }
  }

  // Hottest categories first (by 1w z-score)
  categories.sort((a, b) => (b.median.z1w ?? -Infinity) - (a.median.z1w ?? -Infinity));

  return {
    asOf: new Date().toISOString(),
    benchmarks: benchmarks?.byCategory ?? null,
    categories,
    warnings,
  };
}

// ─── Public ───────────────────────────────────────────────────────────────────

let leaderboardCache = { built: 0, data: null };

async function getLeaderboard({ force = false, benchmarks = null } = {}) {
  if (!force && leaderboardCache.data && Date.now() - leaderboardCache.built < LEADERBOARD_TTL) {
    return leaderboardCache.data;
  }
  const data = await buildLeaderboard({ benchmarks });
  leaderboardCache = { built: Date.now(), data };
  return data;
}

module.exports = {
  getLeaderboard, computeFundStats, navFreshness,
  _config: { MAX_STALE_NAV_DAYS },
};
