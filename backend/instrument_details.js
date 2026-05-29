"use strict";

/**
 * Instrument detail cache builder.
 *
 * For each instrument (stock / MF / ETF), produces a single payload that
 * the frontend detail drawer renders. Stored in radar_cache under keys:
 *   instrument_details.STOCK.<SYMBOL>
 *   instrument_details.MF.<SCHEME_CODE>
 *   instrument_details.ETF.<TICKER>
 *
 * Payload shape:
 *   {
 *     type:        "STOCK" | "MF" | "ETF",
 *     id:          string,
 *     name:        string,
 *     subtitle:    string,
 *     keyStats:    { ... },       // varies by type
 *     chart:       [{ date, val }],
 *     returns:     { ret1w, ret1m, ret3m, ret6m, ret1y, ... },
 *     vsBenchmark: { 1m, 3m, 1y } | null,
 *     news:        [{ title, url, source, date }],
 *     builtAt:     ISO timestamp
 *   }
 *
 * All data sources are free: Yahoo Finance + mfapi.in (already in use elsewhere).
 */

const https = require("https");
const YahooFinance = require("yahoo-finance2").default;

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function httpsGet(url, { json = false, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout: ${url}`)));
    req.on("error", reject);
  });
}

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));

// ─── Stock detail ─────────────────────────────────────────────────────────────

async function buildStockDetail(symbol, { niftyReturns } = {}) {
  const yahooSym = `${symbol}.NS`;

  // One Yahoo call for chart + key stats
  const [chart, summary] = await Promise.all([
    yf.chart(yahooSym, {
      period1: Math.floor((Date.now() - 400 * 86400 * 1000) / 1000),
      interval: "1d",
    }).catch(() => null),
    yf.quoteSummary(yahooSym, {
      modules: ["assetProfile", "price", "summaryDetail", "defaultKeyStatistics", "financialData"],
    }).catch(() => null),
  ]);

  // Optional: news (best-effort)
  let news = [];
  try {
    const s = await yf.search(yahooSym, { newsCount: 8, quotesCount: 0 });
    news = (s?.news ?? []).slice(0, 8).map((n) => ({
      title:  n.title,
      url:    n.link,
      source: n.publisher,
      date:   n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    }));
  } catch {}

  if (!chart?.quotes) throw new Error(`No chart data for ${symbol}`);

  const prices = chart.quotes
    .filter((d) => d.close != null && d.close > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((d) => ({ date: new Date(d.date).toISOString().slice(0, 10), val: round(d.close) }));

  const latest = prices[prices.length - 1];
  const ret = (days) => {
    const target = new Date(Date.now() - days * 86400 * 1000);
    const past = prices.find((p) => new Date(p.date) >= target);
    if (!past || !latest) return null;
    return round(((latest.val - past.val) / past.val) * 100);
  };
  const returns = {
    ret1w: ret(7), ret1m: ret(30), ret3m: ret(90),
    ret6m: ret(180), ret1y: ret(365), ret3y: ret(365 * 3), ret5y: ret(365 * 5),
  };

  // Relative-to-Nifty (where we have the Nifty number)
  let vsBenchmark = null;
  if (niftyReturns) {
    vsBenchmark = {
      "1m": returns.ret1m != null && niftyReturns.ret1m != null ? round(returns.ret1m - niftyReturns.ret1m) : null,
      "3m": returns.ret3m != null && niftyReturns.ret3m != null ? round(returns.ret3m - niftyReturns.ret3m) : null,
      "1y": returns.ret1y != null && niftyReturns.ret1y != null ? round(returns.ret1y - niftyReturns.ret1y) : null,
    };
  }

  const price  = summary?.price ?? {};
  const stats  = summary?.defaultKeyStatistics ?? {};
  const detail = summary?.summaryDetail ?? {};
  const fin    = summary?.financialData ?? {};
  const profile = summary?.assetProfile ?? {};

  const keyStats = {
    sector:           profile.sector ?? null,
    industry:         profile.industry ?? null,
    marketCapCr:      price.marketCap ? round(price.marketCap / 1e7, 0) : null,
    peRatio:          round(detail.trailingPE),
    pbRatio:          round(stats.priceToBook),
    eps:              round(stats.trailingEps),
    dividendYield:    detail.dividendYield != null ? round(detail.dividendYield * 100) : null,
    beta:             round(stats.beta),
    fiftyTwoWeekHigh: round(detail.fiftyTwoWeekHigh),
    fiftyTwoWeekLow:  round(detail.fiftyTwoWeekLow),
    returnOnEquity:   fin.returnOnEquity != null ? round(fin.returnOnEquity * 100) : null,
    earningsGrowth:   fin.earningsGrowth != null ? round(fin.earningsGrowth * 100) : null,
    revenueGrowth:    fin.revenueGrowth  != null ? round(fin.revenueGrowth  * 100) : null,
  };

  return {
    type:     "STOCK",
    id:       symbol,
    name:     price.longName || price.shortName || symbol,
    subtitle: profile.industry || profile.sector || "Indian Equity",
    keyStats,
    chart:    prices,
    returns,
    vsBenchmark,
    news,
    builtAt:  new Date().toISOString(),
  };
}

// ─── MF detail ────────────────────────────────────────────────────────────────

async function buildMfDetail(schemeCode) {
  const data = await httpsGet(`https://api.mfapi.in/mf/${schemeCode}`, { json: true });
  if (!data || !Array.isArray(data.data)) throw new Error(`bad mfapi response for ${schemeCode}`);

  const navs = data.data
    .map((d) => {
      const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d.date);
      if (!m) return null;
      return { date: `${m[3]}-${m[2]}-${m[1]}`, val: parseFloat(d.nav) };
    })
    .filter((n) => n && !isNaN(n.val) && n.val > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const latest = navs[navs.length - 1];
  const ret = (days) => {
    const target = new Date(Date.now() - days * 86400 * 1000);
    const past = navs.find((n) => new Date(n.date) >= target);
    if (!past || !latest) return null;
    return round(((latest.val - past.val) / past.val) * 100);
  };

  return {
    type:     "MF",
    id:       String(schemeCode),
    name:     data.meta?.scheme_name ?? `Scheme ${schemeCode}`,
    subtitle: `${data.meta?.fund_house ?? ""} · ${data.meta?.scheme_category ?? ""}`.trim().replace(/^· /, ""),
    keyStats: {
      schemeCode:    schemeCode,
      schemeType:    data.meta?.scheme_type ?? null,
      fundHouse:     data.meta?.fund_house ?? null,
      latestNav:     round(latest?.val),
      latestNavDate: latest?.date,
    },
    chart:    navs.slice(-400),
    returns:  {
      ret1w: ret(7), ret1m: ret(30), ret3m: ret(90),
      ret6m: ret(180), ret1y: ret(365), ret3y: ret(365 * 3), ret5y: ret(365 * 5),
    },
    vsBenchmark: null,
    news: [],   // MF news is sparse; skip for now
    builtAt: new Date().toISOString(),
  };
}

// ─── ETF detail ───────────────────────────────────────────────────────────────

async function buildEtfDetail(etf) {
  const yahooSym = `${etf.ticker}.NS`;

  const [chart, summary] = await Promise.all([
    yf.chart(yahooSym, {
      period1: Math.floor((Date.now() - 400 * 86400 * 1000) / 1000),
      interval: "1d",
    }).catch(() => null),
    yf.quoteSummary(yahooSym, {
      modules: ["price", "summaryDetail"],
    }).catch(() => null),
  ]);

  if (!chart?.quotes) throw new Error(`No chart data for ETF ${etf.ticker}`);

  const prices = chart.quotes
    .filter((d) => d.close != null && d.close > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((d) => ({ date: new Date(d.date).toISOString().slice(0, 10), val: round(d.close) }));

  const latest = prices[prices.length - 1];
  const ret = (days) => {
    const target = new Date(Date.now() - days * 86400 * 1000);
    const past = prices.find((p) => new Date(p.date) >= target);
    if (!past || !latest) return null;
    return round(((latest.val - past.val) / past.val) * 100);
  };

  const detail = summary?.summaryDetail ?? {};

  return {
    type:     "ETF",
    id:       etf.ticker,
    name:     etf.label,
    subtitle: `${etf.type} · tracks ${etf.benchmark}`,
    keyStats: {
      ticker:           etf.ticker,
      benchmark:        etf.benchmark,
      aumCr:            etf.aumCr,
      ter:              etf.ter,
      latestPrice:      round(latest?.val),
      fiftyTwoWeekHigh: round(detail.fiftyTwoWeekHigh),
      fiftyTwoWeekLow:  round(detail.fiftyTwoWeekLow),
    },
    chart:    prices,
    returns:  {
      ret1w: ret(7), ret1m: ret(30), ret3m: ret(90),
      ret6m: ret(180), ret1y: ret(365), ret3y: ret(365 * 3), ret5y: ret(365 * 5),
    },
    vsBenchmark: null,
    news: [],   // ETF news handled at the underlying-index level — skip per-ETF
    builtAt: new Date().toISOString(),
  };
}

// ─── Batch builder with concurrency ──────────────────────────────────────────

async function buildBatch(items, builder, { concurrency = 4, label = "" } = {}) {
  const results = [];
  const errors = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(slice.map((item) => builder(item)));
    settled.forEach((s, j) => {
      const item = slice[j];
      if (s.status === "fulfilled") {
        results.push(s.value);
      } else {
        errors.push(`${label} ${JSON.stringify(item).slice(0, 40)}: ${s.reason?.message ?? s.reason}`);
      }
    });
  }
  return { results, errors };
}

module.exports = {
  buildStockDetail,
  buildMfDetail,
  buildEtfDetail,
  buildBatch,
};
