"use strict";

/**
 * Nifty 500 universe fetcher.
 *
 * Downloads the official constituent list from NSE archives and caches it
 * locally. Provides {symbol, label, sector} for ~500 stocks covering >95%
 * of NSE EQ market cap.
 *
 * The list changes ~once per quarter (index rebalance) so a 30-day cache
 * is plenty conservative.
 */

const fs   = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "nifty500_cache.json");
const CACHE_TTL  = 30 * 24 * 60 * 60 * 1000; // 30 days
const URL = "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv";

// Map NSE Industry → our existing sector buckets for UI consistency.
// Anything unmapped falls into the literal NSE industry name.
const INDUSTRY_TO_SECTOR = {
  "Financial Services":         "Banking & Finance",
  "Information Technology":     "IT",
  "Oil Gas & Consumable Fuels": "Energy & Oil",
  "Power":                      "Energy & Oil",
  "Consumer Services":          "Consumption & Retail",
  "Fast Moving Consumer Goods": "FMCG",
  "Consumer Durables":          "Consumption & Retail",
  "Healthcare":                 "Pharma",
  "Automobile and Auto Components": "Auto & EV",
  "Capital Goods":              "Capital Goods & Defence",
  "Construction":               "Capital Goods & Defence",
  "Realty":                     "Real Estate",
  "Telecommunication":          "Telecom",
  "Metals & Mining":            "Metals & Mining",
  "Chemicals":                  "Chemicals",
  "Construction Materials":     "Construction Materials",
  "Services":                   "Services",
  "Textiles":                   "Textiles",
  "Media Entertainment & Publication": "Media",
  "Forest Materials":           "Other",
  "Diversified":                "Other",
};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) { /* ignore */ }
  return null;
}

function saveCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE + ".tmp", JSON.stringify(data));
    fs.renameSync(CACHE_FILE + ".tmp", CACHE_FILE);
  } catch (e) { /* ignore */ }
}

function parseCsv(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());
  const iSym  = header.indexOf("Symbol");
  const iName = header.indexOf("Company Name");
  const iInd  = header.indexOf("Industry");
  const iSer  = header.indexOf("Series");
  if (iSym < 0 || iName < 0) throw new Error("Nifty500 CSV header missing expected columns");
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    // simple CSV — names occasionally have commas, handle quoted commas
    const row = parseCsvLine(lines[i]);
    if (row.length <= Math.max(iSym, iName, iInd)) continue;
    const series = (row[iSer] || "").trim();
    if (series && series !== "EQ") continue; // skip non-EQ series
    const symbol = row[iSym].trim();
    if (!symbol) continue;
    const industry = (row[iInd] || "").trim();
    out.push({
      symbol:   `${symbol}.NS`,
      label:    row[iName].trim(),
      sector:   INDUSTRY_TO_SECTOR[industry] || industry || "Other",
      industry,
    });
  }
  return out;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function fetchCsv() {
  const res = await fetch(URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept":     "text/csv,text/plain,*/*",
    },
  });
  if (!res.ok) throw new Error(`NSE Nifty500 fetch ${res.status}`);
  return res.text();
}

async function getNifty500({ force = false } = {}) {
  if (!force) {
    const c = loadCache();
    if (c && Date.now() - new Date(c.fetchedAt).getTime() < CACHE_TTL) return c.stocks;
  }
  const csv    = await fetchCsv();
  const stocks = parseCsv(csv);
  if (stocks.length < 100) throw new Error(`Nifty500 list looks broken (${stocks.length} stocks)`);
  saveCache({ fetchedAt: new Date().toISOString(), stocks });
  return stocks;
}

module.exports = { getNifty500 };
