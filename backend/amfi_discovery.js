"use strict";

/**
 * AMFI-driven dynamic universe discovery.
 *
 * Parses the AMFI NAVAll.txt file (cached 24h) to discover:
 *   - MF schemes per category, supplementing the static mf_universe.js
 *   - ETF-type schemes (code + name + ISIN) for future ticker resolution
 *
 * Key design:
 *   - Only "Direct ... Growth" plans are included (canonical performance tracking)
 *   - Existing static entries always win; AMFI fills gaps up to MAX_PER_CATEGORY
 *   - Discovery failure falls back gracefully to the static universe
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");
const { atomicWrite } = require("./utils");

const AMFI_URL         = "https://www.amfiindia.com/spages/NAVAll.txt";
const CACHE_FILE       = path.join(__dirname, "amfi_discovery_cache.json");
const CACHE_TTL_MS     = 24 * 60 * 60 * 1000;
const MAX_PER_CATEGORY = 12;  // expand each category to at most 12 funds

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function httpsGet(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error(`too many redirects: ${url}`));
    const req = https.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(httpsGet(res.headers.location, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve(data));
    });
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let _cache = null;

function loadCache() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (_e) {}
  return _cache || { fetchedAt: 0, mfCategories: {}, etfs: [] };
}

function saveCache(data) {
  _cache = data;
  try { atomicWrite(CACHE_FILE, JSON.stringify(data)); } catch (_e) {}
}

// ─── Category mapping ─────────────────────────────────────────────────────────

// AMFI section header substring → our category key (exact match on trimmed substring)
const AMFI_SECTION_MAP = {
  "Equity Scheme - Large Cap Fund":                           "Large Cap",
  "Equity Scheme - Mid Cap Fund":                             "Mid Cap",
  "Equity Scheme - Small Cap Fund":                          "Small Cap",
  "Equity Scheme - Flexi Cap Fund":                          "Flexi Cap",
  "Equity Scheme - ELSS":                                    "ELSS",
  "Equity Scheme - Value Fund/Contra Fund":                  "Value",
  "Equity Scheme - Large & Mid Cap Fund":                    "Large & Mid Cap",
  "Equity Scheme - Focused Fund":                            "Focused",
  "Other Scheme - Gold Fund":                                "Gold",
  "Fund of Funds (Overseas/International)":                  "International / Global",
  "Other Scheme - Fund of Funds (Overseas/International)":   "International / Global",
};

// For sectoral/thematic, map by keywords in scheme name (lower-case)
const SECTORAL_KEYWORDS = [
  { words: ["defence", "defense"],                    cat: "Defence" },
  { words: ["psu", "public sector unit"],             cat: "PSU" },
  { words: ["tech", "digital india", "it fund", "information tech"], cat: "Technology" },
  { words: ["pharma", "healthcare"],                  cat: "Pharma & Healthcare" },
  { words: ["bank", "financial services", "bfsi"],    cat: "Banking & Financial" },
  { words: ["infra", "infrastructure"],               cat: "Infrastructure" },
  { words: ["manufacturing", "make in india"],        cat: "Manufacturing" },
  { words: ["consumption", "fmcg", "consumer"],       cat: "Consumption" },
  { words: ["energy", "power & infra", "natural res"], cat: "Energy" },
  { words: ["microcap", "micro cap", "nifty microcap"], cat: "Micro Cap" },
];

const ETF_SECTION_RE = /exchange traded fund|gold etf/i;

// ─── Parser ───────────────────────────────────────────────────────────────────

function isDirectGrowth(name) {
  const n = name.toLowerCase();
  return n.includes("direct") && (n.includes("growth") || n.includes("growth option"));
}

function sectoralCategory(name) {
  const n = name.toLowerCase();
  for (const { words, cat } of SECTORAL_KEYWORDS) {
    if (words.some((w) => n.includes(w))) return cat;
  }
  return null;
}

function cleanLabel(name) {
  return name
    .replace(/ - Direct Plan.*$/i, "")
    .replace(/ - Direct.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNavAll(text) {
  const mfCategories = {};
  const etfs = [];

  let currentSection = null;
  let isEtf = false;
  let isOpen = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || /^;+$/.test(line)) continue;

    // "Open Ended Schemes(Equity Scheme - Large Cap Fund)"
    const openMatch = line.match(/^Open Ended Schemes?\((.+?)\)/i);
    if (openMatch) {
      isOpen = true;
      currentSection = openMatch[1].trim();
      isEtf = ETF_SECTION_RE.test(currentSection);
      continue;
    }
    // Closed-ended, Interval — skip
    if (/^(Close|Interval)\s+Ended/i.test(line)) {
      isOpen = false;
      currentSection = null;
      isEtf = false;
      continue;
    }

    if (!isOpen) continue;

    // Data line: code;isin1;isin2;name;nav;date
    const parts = line.split(";");
    if (parts.length < 5) continue;
    const code = parts[0].trim();
    if (!/^\d+$/.test(code)) continue;

    const name = parts[3].trim();
    if (!name) continue;
    const nav  = parseFloat(parts[4]);

    if (isEtf) {
      const isin = parts[1].trim() || parts[2].trim() || null;
      etfs.push({ code, name, nav: isNaN(nav) ? null : nav, isin });
      continue;
    }

    // Only direct growth MF plans
    if (!isDirectGrowth(name)) continue;

    // Map to our category
    let cat = AMFI_SECTION_MAP[currentSection] ?? null;
    if (cat === undefined) {
      // Sectoral/Thematic section — match by scheme name keywords
      if (/sectoral|thematic/i.test(currentSection)) {
        cat = sectoralCategory(name);
      }
    }
    if (!cat) continue;

    if (!mfCategories[cat]) mfCategories[cat] = [];
    mfCategories[cat].push({ code, label: cleanLabel(name) });
  }

  return { mfCategories, etfs };
}

// ─── Fetch + cache ────────────────────────────────────────────────────────────

async function fetchParsed() {
  const cached = loadCache();
  if (cached.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  const text = await httpsGet(AMFI_URL);
  const { mfCategories, etfs } = parseNavAll(text);
  const result = { fetchedAt: Date.now(), mfCategories, etfs };
  saveCache(result);
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Expand the static CATEGORIES map from mf_universe.js with AMFI-discovered
 * funds. Static entries always come first and are never replaced.
 *
 * @param {Object} staticCategories  { "Large Cap": [{code, label}, ...], ... }
 * @returns {Object}                 Same shape, with extra funds per category
 *                                   and AMFI-only categories appended.
 */
async function getDynamicMfCategories(staticCategories) {
  let amfi;
  try {
    amfi = await fetchParsed();
  } catch (e) {
    console.warn(`[amfi_discovery] fetch failed, using static universe: ${e.message}`);
    return staticCategories;
  }

  const result = {};

  // Expand existing static categories
  for (const [cat, staticFunds] of Object.entries(staticCategories)) {
    const staticCodes = new Set(staticFunds.map((f) => f.code));
    const discovered  = (amfi.mfCategories[cat] || [])
      .filter((f) => !staticCodes.has(f.code))
      .slice(0, Math.max(0, MAX_PER_CATEGORY - staticFunds.length));
    result[cat] = [...staticFunds, ...discovered];
  }

  // Add AMFI-only categories (e.g. "International / Global", "Focused")
  for (const [cat, funds] of Object.entries(amfi.mfCategories)) {
    if (result[cat]) continue;
    result[cat] = funds.slice(0, MAX_PER_CATEGORY);
  }

  return result;
}

/**
 * Return all ETF-type schemes parsed from AMFI.
 * Used as a supplementary list; each entry: { code, name, nav, isin }
 */
async function getAmfiEtfList() {
  try {
    const amfi = await fetchParsed();
    return amfi.etfs;
  } catch (e) {
    console.warn(`[amfi_discovery] ETF list unavailable: ${e.message}`);
    return [];
  }
}

module.exports = { getDynamicMfCategories, getAmfiEtfList };
