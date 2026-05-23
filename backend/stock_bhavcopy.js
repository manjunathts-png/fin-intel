"use strict";

/**
 * NSE Bhavcopy fetcher — delivery percentage per stock.
 *
 * Downloads `sec_bhavdata_full_DDMMYYYY.csv` from nsearchives.nseindia.com.
 * Returns a map of { SYMBOL → deliveryPct } for the most recent trading day.
 *
 * Delivery % is a measure of conviction: % of traded volume that was actually
 * delivered (settled) vs intraday-squared positions. High delivery % on a
 * volume-shocked day is a strong signal of institutional accumulation.
 *
 * The file is published EOD around 6pm IST. If the current day's file isn't
 * available yet, we walk back up to 5 days to find the most recent.
 */

const fs   = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "bhavcopy_cache.json");
const CACHE_TTL  = 12 * 60 * 60 * 1000; // 12 hours

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

function ddmmyyyy(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}${m}${y}`;
}

async function fetchOneDay(date) {
  const dateStr = ddmmyyyy(date);
  const url = `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${dateStr}.csv`;
  const res = await fetch(url, {
    headers: {
      // NSE needs realistic UA or it returns 403
      "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept":          "text/csv,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer":         "https://www.nseindia.com/",
    },
  });
  if (!res.ok) throw new Error(`NSE ${res.status} for ${dateStr}`);
  return res.text();
}

function parseBhavcopy(csv) {
  // Header (post-2020 format):
  // SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE,
  // LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS,
  // NO_OF_TRADES, DELIV_QTY, DELIV_PER
  //
  // Some columns have leading/trailing spaces in the header. Normalize.
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("empty bhavcopy");

  const header = lines[0].split(",").map((h) => h.trim());
  const symIdx = header.indexOf("SYMBOL");
  const serIdx = header.indexOf("SERIES");
  const delPct = header.indexOf("DELIV_PER");
  const delQty = header.indexOf("DELIV_QTY");
  const ttlQty = header.indexOf("TTL_TRD_QNTY");

  if (symIdx < 0 || serIdx < 0 || delPct < 0) {
    throw new Error("bhavcopy header missing expected columns");
  }

  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    if (cols.length <= delPct) continue;
    const series = cols[serIdx];
    // Only EQ series for cash-market equities
    if (series !== "EQ" && series !== "BE") continue;
    const symbol = cols[symIdx];
    const pctRaw = cols[delPct];
    const pct    = parseFloat(pctRaw);
    if (!isFinite(pct)) continue;
    out[symbol] = {
      deliveryPct: parseFloat(pct.toFixed(2)),
      deliveryQty: parseInt(cols[delQty], 10) || 0,
      totalQty:    parseInt(cols[ttlQty], 10) || 0,
    };
  }
  return out;
}

async function getDeliveryMap({ force = false } = {}) {
  if (!force) {
    const cached = loadCache();
    if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL) {
      return cached;
    }
  }

  const today = new Date();
  let lastError = null;
  for (let off = 0; off < 6; off++) {
    const d = new Date(today);
    d.setDate(d.getDate() - off);
    const day = d.getDay();
    if (day === 0 || day === 6) continue; // skip weekends
    try {
      const csv = await fetchOneDay(d);
      const map = parseBhavcopy(csv);
      const result = {
        date:      d.toISOString().slice(0, 10),
        fetchedAt: new Date().toISOString(),
        count:     Object.keys(map).length,
        symbols:   Object.fromEntries(
          Object.entries(map).map(([k, v]) => [k, v.deliveryPct])
        ),
      };
      saveCache(result);
      return result;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("no bhavcopy found in last 6 days");
}

module.exports = { getDeliveryMap };
