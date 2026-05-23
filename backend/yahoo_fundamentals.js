"use strict";

/**
 * Yahoo Finance fundamentals for a set of symbols.
 *
 * Uses yahoo-finance2 quoteSummary modules: summaryDetail, financialData,
 * defaultKeyStatistics, assetProfile. Per-symbol cached for 24h.
 *
 * Returns:
 *   marketCap, marketCapCr, trailingPE, forwardPE, dividendYield,
 *   earningsGrowth, revenueGrowth, returnOnEquity, profitMargins,
 *   sector, industry, fullExchangeName
 */

const fs   = require("fs");
const path = require("path");
const YahooFinance = require("yahoo-finance2").default;

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CACHE_FILE = path.join(__dirname, "yahoo_fundamentals_cache.json");
const TTL        = 24 * 60 * 60 * 1000;

let cache = loadCache();

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) { /* ignore */ }
  return { symbols: {} };
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE + ".tmp", JSON.stringify(cache));
    fs.renameSync(CACHE_FILE + ".tmp", CACHE_FILE);
  } catch (e) { /* ignore */ }
}

async function getFundamentals(symbol) {
  const cached = cache.symbols[symbol];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < TTL) {
    return cached.data;
  }
  let qs;
  try {
    qs = await yahooFinance.quoteSummary(symbol, {
      modules: ["summaryDetail", "financialData", "defaultKeyStatistics", "assetProfile", "price"],
    });
  } catch (e) {
    // Cache the failure for a shorter window so we don't repeatedly retry
    cache.symbols[symbol] = { fetchedAt: new Date().toISOString(), data: null };
    saveCache();
    return null;
  }
  const sd = qs?.summaryDetail ?? {};
  const fd = qs?.financialData ?? {};
  const ks = qs?.defaultKeyStatistics ?? {};
  const ap = qs?.assetProfile ?? {};
  const pr = qs?.price ?? {};

  const mc = sd.marketCap ?? pr.marketCap ?? null;
  const data = {
    marketCap:        mc,
    marketCapCr:      mc ? +(mc / 1e7).toFixed(0) : null,           // ₹ crore
    trailingPE:       sd.trailingPE ?? null,
    forwardPE:        sd.forwardPE  ?? null,
    dividendYield:    sd.dividendYield ? +(sd.dividendYield * 100).toFixed(2) : null,
    earningsGrowth:   fd.earningsGrowth ? +(fd.earningsGrowth * 100).toFixed(1) : null,
    revenueGrowth:    fd.revenueGrowth  ? +(fd.revenueGrowth  * 100).toFixed(1) : null,
    returnOnEquity:   fd.returnOnEquity ? +(fd.returnOnEquity * 100).toFixed(1) : null,
    profitMargins:    fd.profitMargins  ? +(fd.profitMargins  * 100).toFixed(1) : null,
    debtToEquity:     fd.debtToEquity ?? null,
    sector:           ap.sector ?? null,
    industry:         ap.industry ?? null,
    longName:         pr.longName ?? null,
    fullExchangeName: pr.fullExchangeName ?? null,
  };
  cache.symbols[symbol] = { fetchedAt: new Date().toISOString(), data };
  saveCache();
  return data;
}

async function getFundamentalsBatch(symbols, { concurrency = 5 } = {}) {
  const out = {};
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (s) => [s, await getFundamentals(s)]));
    for (const [s, d] of results) out[s] = d;
  }
  return out;
}

module.exports = { getFundamentals, getFundamentalsBatch };
