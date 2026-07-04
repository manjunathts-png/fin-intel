"use strict";

/**
 * Nifty 50 benchmark fetcher — used for relative-strength calculation.
 *
 * Stores 1Y of daily closes so we can compute Nifty's 1W/1M/3M/6M/1Y
 * returns, then subtract from each stock's own return to derive RS.
 *
 * Source priority (Yahoo Finance is blocked on GitHub Actions IPs):
 *   1. Stooq  — free CSV, no auth, works on CI (symbol: ^nsei)
 *   2. Yahoo Finance v8 REST  — fallback, may be blocked on shared IPs
 */

const fs   = require("fs");
const path = require("path");

const CACHE_FILE    = path.join(__dirname, "nifty_benchmark_cache.json");
const TTL           = 6 * 60 * 60 * 1000; // 6h
const FETCH_UA      = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const NSE_IDX_ARCH  = "https://nsearchives.nseindia.com/content/indices";
const MAX_IDX_PAR   = 20; // parallel downloads for index archive

function yyyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

// ─── Source 1: Stooq ──────────────────────────────────────────────────────────

async function fetchNiftyFromStooq(startDate) {
  const d1  = yyyymmdd(startDate);
  const d2  = yyyymmdd(new Date(Date.now() + 86400000));
  const url = `https://stooq.com/q/d/l/?s=^nsei&d1=${d1}&d2=${d2}&i=d`;
  const res = await fetch(url, {
    headers: { "User-Agent": FETCH_UA },
    signal:  AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < 50 || !text.toLowerCase().startsWith("date")) {
    throw new Error(`stooq: unexpected response (len=${text.length})`);
  }
  const lines   = text.trim().split(/\r?\n/);
  const headers = lines[0].toLowerCase().split(",");
  const iDate   = headers.indexOf("date");
  const iClose  = headers.indexOf("close");
  if (iDate < 0 || iClose < 0) throw new Error("stooq: unexpected CSV header for ^nsei");

  const prices = [];
  for (let i = 1; i < lines.length; i++) {
    const cols  = lines[i].split(",");
    const close = parseFloat(cols[iClose]);
    if (!isFinite(close) || close <= 0) continue;
    prices.push({ date: cols[iDate]?.trim() ?? "", close });
  }
  prices.sort((a, b) => a.date.localeCompare(b.date));
  if (prices.length === 0) throw new Error("stooq: empty dataset for ^nsei");
  return prices;
}

// ─── Source 2: NSE Index Archive (no cookies, CI-friendly) ───────────────────

function ddmmyyyyIdx(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}${m}${y}`;
}

async function fetchOneIndexFile(date) {
  const fname = `ind_close_all_${ddmmyyyyIdx(date)}.csv`;
  const url   = `${NSE_IDX_ARCH}/${fname}`;
  const res   = await fetch(url, {
    headers: { "User-Agent": FETCH_UA },
    signal:  AbortSignal.timeout(15000),
  });
  if (!res.ok) return null; // non-trading day — silently skip
  const text = await res.text();
  if (text.length < 30 || !text.toLowerCase().startsWith("index")) return null;
  const lines = text.trim().split(/\r?\n/);
  const hdr   = lines[0].toLowerCase().split(",");
  const iName  = hdr.indexOf("index name");
  const iDate  = hdr.indexOf("index date");
  const iClose = hdr.findIndex((h) => h.includes("closing"));
  if (iName < 0 || iDate < 0 || iClose < 0) return null;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if ((cols[iName] ?? "").trim().toLowerCase() !== "nifty 50") continue;
    const raw   = cols[iDate]?.trim() ?? "";
    const close = parseFloat(cols[iClose]);
    if (!isFinite(close) || close <= 0) return null;
    // Date format from NSE: "DD-Mon-YYYY" e.g. "04-Jun-2026"
    const m = /^(\d{2})-(\w{3})-(\d{4})$/.exec(raw);
    if (!m) return null;
    const months = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
                     jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
    const mo = months[m[2].toLowerCase()];
    if (!mo) return null;
    return { date: `${m[3]}-${mo}-${m[1]}`, close };
  }
  return null; // "Nifty 50" row not found
}

async function fetchNiftyFromNseIndexArchive(startDate) {
  const dates = [];
  const cursor = new Date(startDate);
  const today  = new Date();
  while (cursor <= today) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) dates.push(new Date(cursor)); // skip weekends
    cursor.setDate(cursor.getDate() + 1);
  }

  const prices = [];
  for (let i = 0; i < dates.length; i += MAX_IDX_PAR) {
    const batch   = dates.slice(i, i + MAX_IDX_PAR);
    const results = await Promise.all(batch.map((d) => fetchOneIndexFile(d).catch(() => null)));
    for (const r of results) { if (r) prices.push(r); }
  }

  prices.sort((a, b) => a.date.localeCompare(b.date));
  if (prices.length === 0) throw new Error("NSE index archive: no Nifty 50 data found");
  return prices;
}

// ─── Source 3: Yahoo Finance v8 REST (fallback) ───────────────────────────────

async function fetchNiftyFromYahooRest(startDate) {
  const period1 = Math.floor(startDate.getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  const params  = new URLSearchParams({ interval: "1d", period1, period2, events: "history" });
  for (const base of [
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com",
  ]) {
    const url = `${base}/v8/finance/chart/%5ENSEI?${params}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": FETCH_UA, "Accept": "application/json" },
        signal:  AbortSignal.timeout(20000),
      });
      if (res.status === 429) break;
      if (!res.ok) continue;
      const data   = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const timestamps = result.timestamp ?? [];
      const closes     = result.indicators?.quote?.[0]?.close ?? [];
      if (!timestamps.length || !closes.length) continue;
      const prices = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = closes[i];
        if (close == null || close <= 0) continue;
        prices.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close });
      }
      prices.sort((a, b) => a.date.localeCompare(b.date));
      if (prices.length > 0) return prices;
    } catch (e) {
      console.warn(`  [yahoo] ^NSEI (${base.split("/")[2]}): ${e.message}`);
    }
  }
  return null;
}

// ─── Cached history with source fallback ─────────────────────────────────────

async function getNiftyHistory() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL) return cached.prices;
    }
  } catch (e) { /* ignore */ }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 400);

  let prices = null;
  try {
    prices = await fetchNiftyFromStooq(startDate);
  } catch (e) {
    console.warn(`  [stooq] ^NSEI: ${e.message} — trying NSE index archive…`);
  }

  if (!prices || prices.length === 0) {
    try {
      prices = await fetchNiftyFromNseIndexArchive(startDate);
    } catch (e) {
      console.warn(`  [nse-arch] ^NSEI: ${e.message} — trying Yahoo REST…`);
    }
  }

  if (!prices || prices.length === 0) {
    prices = await fetchNiftyFromYahooRest(startDate);
  }

  if (!prices || prices.length === 0) {
    throw new Error("Nifty benchmark unavailable (Stooq, NSE archive, and Yahoo all failed)");
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), prices }));
  return prices;
}

function returnOver(prices, days) {
  if (prices.length === 0) return null;
  const latest    = prices[prices.length - 1].close;
  const target    = new Date();
  target.setDate(target.getDate() - days);
  const targetStr = target.toISOString().slice(0, 10);
  let lo = 0, hi = prices.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (prices[mid].date <= targetStr) lo = mid;
    else hi = mid - 1;
  }
  const past = prices[lo].close;
  if (!past || past <= 0) return null;
  return ((latest - past) / past) * 100;
}

async function getNiftyReturns() {
  const prices = await getNiftyHistory();
  return {
    ret1w: returnOver(prices, 7),
    ret1m: returnOver(prices, 30),
    ret3m: returnOver(prices, 90),
    ret6m: returnOver(prices, 180),
    ret1y: returnOver(prices, 365),
  };
}

module.exports = { getNiftyReturns, getNiftyHistory };
