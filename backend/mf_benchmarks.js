"use strict";

/**
 * MF Category Benchmarks — fetches NSE index closes via Yahoo Finance to
 * compute the appropriate benchmark return per MF category.
 *
 * Mapping uses NSE's standard category indices:
 *   Large Cap          → Nifty 100        (^CNX100 / ^NSEI as fallback)
 *   Mid Cap            → Nifty Midcap 150 (^NSEMDCP50 / NIFTY_MIDCAP_100.NS)
 *   Small Cap          → Nifty Smallcap 250
 *   Micro Cap          → Nifty Microcap 250 (^CNXMCAP / fallback Smallcap)
 *   Flexi Cap          → Nifty 500
 *   ELSS               → Nifty 500
 *   Pharma & Healthcare→ Nifty Pharma     (^CNXPHARMA)
 *   Banking & Finance  → Nifty Bank       (^NSEBANK)
 *   IT / Technology    → Nifty IT         (^CNXIT)
 *   PSU                → Nifty PSU Bank   (^CNXPSUBANK) / fallback Nifty 100
 *   Energy             → Nifty Energy     (^CNXENERGY)
 *   Infrastructure     → Nifty Infra      (^CNXINFRA)
 *   Defence            → Nifty India Defence (^CNXDEFENCE) — fallback Nifty 500
 *   Manufacturing      → Nifty India Manufacturing (^CNXMFG) / fallback Nifty 500
 */

const fs = require("fs");
const path = require("path");
const YahooFinance = require("yahoo-finance2").default;

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CACHE_FILE = path.join(__dirname, "mf_benchmark_cache.json");
const TTL = 6 * 60 * 60 * 1000;
const HISTORY_DAYS = 365 * 12; // 12 years to support 10Y CAGR

// Category → primary benchmark symbol (with fallbacks)
const CATEGORY_BENCHMARK = {
  "Large Cap":            { symbol: "^CNX100",     label: "Nifty 100" },
  "Mid Cap":              { symbol: "NIFTY_MID_SELECT.NS", label: "Nifty Midcap Select", fallback: "^NSEI" },
  "Small Cap":            { symbol: "^CNXSC",      label: "Nifty Smallcap 100", fallback: "^NSEI" },
  "Micro Cap":            { symbol: "^CNXSC",      label: "Nifty Smallcap 100 (proxy)", fallback: "^NSEI" },
  "Flexi Cap":            { symbol: "^CRSLDX",     label: "Nifty 500",  fallback: "^NSEI" },
  "ELSS":                 { symbol: "^CRSLDX",     label: "Nifty 500",  fallback: "^NSEI" },
  "Pharma & Healthcare":  { symbol: "^CNXPHARMA",  label: "Nifty Pharma" },
  "Banking & Finance":    { symbol: "^NSEBANK",    label: "Nifty Bank" },
  "Technology":           { symbol: "^CNXIT",      label: "Nifty IT" },
  "PSU":                  { symbol: "^CNXPSUBANK", label: "Nifty PSU Bank", fallback: "^CNX100" },
  "Energy":               { symbol: "^CNXENERGY",  label: "Nifty Energy" },
  "Infrastructure":       { symbol: "^CNXINFRA",   label: "Nifty Infra" },
  "Defence":              { symbol: "^CRSLDX",     label: "Nifty 500 (proxy)" },
  "Manufacturing":        { symbol: "^CRSLDX",     label: "Nifty 500 (proxy)" },
};

const FALLBACK_INDEX = { symbol: "^NSEI", label: "Nifty 50" };

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) { /* ignore */ }
  return null;
}
function saveCache(d) {
  try {
    fs.writeFileSync(CACHE_FILE + ".tmp", JSON.stringify(d));
    fs.renameSync(CACHE_FILE + ".tmp", CACHE_FILE);
  } catch (e) { /* ignore */ }
}

async function fetchIndexHistory(symbol) {
  const period1 = new Date();
  period1.setDate(period1.getDate() - HISTORY_DAYS);
  const data = await yahooFinance.chart(symbol, {
    period1: Math.floor(period1.getTime() / 1000),
    interval: "1d",
  });
  return (data.quotes || [])
    .filter((d) => d.close != null && d.close > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((d) => ({ date: new Date(d.date).toISOString().slice(0, 10), close: d.close }));
}

function returnOver(prices, days) {
  if (prices.length === 0) return null;
  const latest = prices[prices.length - 1].close;
  const t = new Date(); t.setDate(t.getDate() - days);
  const tStr = t.toISOString().slice(0, 10);
  let lo = 0, hi = prices.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (prices[mid].date <= tStr) lo = mid;
    else hi = mid - 1;
  }
  const past = prices[lo].close;
  if (!past || past <= 0) return null;
  return ((latest - past) / past) * 100;
}

function cagrOver(prices, years) {
  if (prices.length === 0) return null;
  const latest = prices[prices.length - 1].close;
  const t = new Date(); t.setDate(t.getDate() - years * 365);
  const tStr = t.toISOString().slice(0, 10);
  let lo = 0, hi = prices.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (prices[mid].date <= tStr) lo = mid;
    else hi = mid - 1;
  }
  const past = prices[lo].close;
  if (!past || past <= 0) return null;
  return (Math.pow(latest / past, 1 / years) - 1) * 100;
}

async function safeFetch(symbol) {
  try {
    const prices = await fetchIndexHistory(symbol);
    return prices.length > 0 ? prices : null;
  } catch (e) {
    return null;
  }
}

async function buildBenchmarkData() {
  // Collect unique symbols (including fallbacks)
  const wanted = new Set();
  for (const cat of Object.values(CATEGORY_BENCHMARK)) {
    wanted.add(cat.symbol);
    if (cat.fallback) wanted.add(cat.fallback);
  }
  wanted.add(FALLBACK_INDEX.symbol);

  const results = {};
  for (const sym of wanted) {
    const prices = await safeFetch(sym);
    if (prices) {
      results[sym] = {
        ret1y:   parseFloat((returnOver(prices, 365) ?? 0).toFixed(2)),
        ret3y:   parseFloat((returnOver(prices, 3 * 365) ?? 0).toFixed(2)),
        ret5y:   parseFloat((returnOver(prices, 5 * 365) ?? 0).toFixed(2)),
        cagr3y:  parseFloat((cagrOver(prices, 3) ?? 0).toFixed(2)),
        cagr5y:  parseFloat((cagrOver(prices, 5) ?? 0).toFixed(2)),
        cagr10y: parseFloat((cagrOver(prices, 10) ?? 0).toFixed(2)),
      };
    }
  }

  // Build per-category benchmark struct
  const byCategory = {};
  for (const [category, conf] of Object.entries(CATEGORY_BENCHMARK)) {
    const data = results[conf.symbol] || (conf.fallback && results[conf.fallback]) || results[FALLBACK_INDEX.symbol];
    const usedSymbol = results[conf.symbol] ? conf.symbol
                     : conf.fallback && results[conf.fallback] ? conf.fallback
                     : FALLBACK_INDEX.symbol;
    const usedLabel = usedSymbol === conf.symbol ? conf.label
                    : usedSymbol === conf.fallback ? `${conf.label} (fallback)`
                    : FALLBACK_INDEX.label;
    byCategory[category] = data ? { symbol: usedSymbol, label: usedLabel, ...data } : null;
  }

  return { fetchedAt: new Date().toISOString(), byCategory, raw: results };
}

async function getBenchmarks({ force = false } = {}) {
  if (!force) {
    const c = loadCache();
    if (c && Date.now() - new Date(c.fetchedAt).getTime() < TTL) return c;
  }
  const data = await buildBenchmarkData();
  saveCache(data);
  return data;
}

module.exports = { getBenchmarks, CATEGORY_BENCHMARK };
