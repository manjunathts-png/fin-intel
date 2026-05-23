"use strict";

/**
 * Nifty 50 benchmark fetcher — used for relative-strength calculation.
 *
 * Stores 1Y of daily closes so we can compute Nifty's 1W/1M/3M/6M/1Y
 * returns, then subtract from each stock's own return to derive RS.
 */

const fs = require("fs");
const path = require("path");
const YahooFinance = require("yahoo-finance2").default;

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CACHE_FILE = path.join(__dirname, "nifty_benchmark_cache.json");
const TTL = 6 * 60 * 60 * 1000; // 6h
const SYMBOL = "^NSEI";

async function getNiftyHistory() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL) return cached.prices;
    }
  } catch (e) { /* ignore */ }

  const period1 = new Date();
  period1.setDate(period1.getDate() - 400);
  const data = await yahooFinance.chart(SYMBOL, {
    period1: Math.floor(period1.getTime() / 1000),
    interval: "1d",
  });
  const prices = (data.quotes || [])
    .filter((d) => d.close != null && d.close > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((d) => ({ date: new Date(d.date).toISOString().slice(0, 10), close: d.close }));

  fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), prices }));
  return prices;
}

function returnOver(prices, days) {
  if (prices.length === 0) return null;
  const latest = prices[prices.length - 1].close;
  const target = new Date();
  target.setDate(target.getDate() - days);
  const targetStr = target.toISOString().slice(0, 10);
  // binary search for closest <= target
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

module.exports = { getNiftyReturns };
