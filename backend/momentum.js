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

function atomicWrite(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
const { CATEGORIES } = require("./mf_universe");

const CACHE_FILE = path.join(__dirname, "mf_history_cache.json");
const AMFI_URL = "https://www.amfiindia.com/spages/NAVAll.txt";
const MFAPI_URL = (code) => `https://api.mfapi.in/mf/${code}`;
const NAV_HISTORY_DAYS = 400;
const SCHEME_TTL = 24 * 60 * 60 * 1000;
const AMFI_TTL = 24 * 60 * 60 * 1000;
const LEADERBOARD_TTL = 60 * 60 * 1000;

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

// ─── Scheme NAV history ───────────────────────────────────────────────────────

async function fetchSchemeHistory(code) {
  const cached = cache.schemes[code];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < SCHEME_TTL) {
    return cached;
  }

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
  return entry;
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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
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

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
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

function computeFundStats(navs) {
  const ret1w = pctReturn(navs, 7);
  const ret1m = pctReturn(navs, 30);
  const ret3m = pctReturn(navs, 90);
  const ret6m = pctReturn(navs, 180);
  const ret1y = pctReturn(navs, 365);

  const weekly = rollingWeeklyReturns(navs, 90);
  const wStd = stddev(weekly);
  const wMean = mean(weekly);
  const z1w = ret1w != null && wStd > 0 ? (ret1w - wMean) / wStd : null;

  return {
    ret1w: round2(ret1w),
    ret1m: round2(ret1m),
    ret3m: round2(ret3m),
    ret6m: round2(ret6m),
    ret1y: round2(ret1y),
    z1w:   round2(z1w),
  };
}

function categoryAggregate(funds) {
  const pick = (k) => funds.map((f) => f[k]).filter((v) => v != null);
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
  // AMFI list is still fetched for latest NAV lookups; fund codes come from universe config
  let amfiList = {};
  try { amfiList = await getAmfiList(); } catch (e) {
    console.warn("AMFI list fetch failed (will skip latest NAV):", e.message);
  }

  const categories = [];
  const warnings = [];

  for (const [categoryName, fundEntries] of Object.entries(CATEGORIES)) {
    const funds = [];

    for (const fund of fundEntries) {
      const { code, label } = fund;
      try {
        const entry = await fetchSchemeHistory(code);
        const stats = computeFundStats(entry.navs);
        funds.push({
          code,
          label,
          name: entry.name || amfiList[code]?.name || label,
          latestNav: amfiList[code]?.nav ?? null,
          ...stats,
        });
      } catch (e) {
        warnings.push(`History fetch failed for ${code} (${label}): ${e.message}`);
      }
    }

    funds.sort((a, b) => (b.ret1w ?? -Infinity) - (a.ret1w ?? -Infinity));

    categories.push({
      category: categoryName,
      fundCount: funds.length,
      median: categoryAggregate(funds),
      funds,
    });
  }

  // Hottest categories first (by 1w z-score)
  categories.sort((a, b) => (b.median.z1w ?? -Infinity) - (a.median.z1w ?? -Infinity));

  return {
    asOf: new Date().toISOString(),
    categories,
    warnings,
  };
}

// ─── Public ───────────────────────────────────────────────────────────────────

let leaderboardCache = { built: 0, data: null };

async function getLeaderboard({ force = false } = {}) {
  if (!force && leaderboardCache.data && Date.now() - leaderboardCache.built < LEADERBOARD_TTL) {
    return leaderboardCache.data;
  }
  const data = await buildLeaderboard();
  leaderboardCache = { built: Date.now(), data };
  return data;
}

module.exports = { getLeaderboard };
