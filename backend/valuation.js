"use strict";

/**
 * Sector-relative value + quality scoring (v1, cross-sectional only).
 *
 * Each stock gets two 0–100 percentile scores against its sector peers:
 *   valueScore   — how cheap it is (100 = cheapest in peer group)
 *   qualityScore — how strong the business is (100 = best in peer group)
 *
 * The valuation method depends on the business model, because the right
 * multiple differs by sector:
 *   lender    — banks, NBFCs, housing finance: book value drives value
 *               (P/B), and returns on equity/assets drive quality. Leverage
 *               and EBITDA are meaningless for a lender.
 *   financial — insurers, AMCs, exchanges, brokers: earnings + book.
 *   standard  — everyone else: earnings, EV/EBITDA (debt-neutral, works for
 *               cyclicals) and book.
 *
 * Peer group = sector bucket + method. Metrics with fewer than MIN_PEERS
 * values in the group fall back to all stocks using the same method.
 *
 * There is no fundamentals history yet (stock_fundamentals_history only
 * started filling on 2026-11-24), so these scores are untested as return
 * predictors. They are shown in the UI and only act on the composite
 * through a small penalty for stocks that are both expensive and low
 * quality versus peers.
 */

const MIN_PEERS = 5;
const PENALTY_VALUE_MAX   = 20;   // valueScore below this = expensive vs peers
const PENALTY_QUALITY_MAX = 30;   // qualityScore below this = weak vs peers
const VALUATION_PENALTY   = 4;    // positive magnitude, caller subtracts
const LOSS = -1;                  // sentinel yield for loss-making / negative-equity names

const LENDER_INDUSTRY = /bank|credit services|mortgage|financial conglomerate/i;
const FINANCIAL_SECTOR = "Banking & Finance";

const WEIGHTS = {
  lender:    { value: { bookYield: 0.6, earningsYield: 0.4 },
               quality: { roe: 0.4, roa: 0.3, growth: 0.3 } },
  financial: { value: { earningsYield: 0.7, bookYield: 0.3 },
               quality: { roe: 0.4, margin: 0.3, growth: 0.3 } },
  standard:  { value: { earningsYield: 0.4, ebitdaYield: 0.4, bookYield: 0.2 },
               quality: { roe: 0.35, margin: 0.25, lowLeverage: 0.2, growth: 0.2 } },
};

function valuationMethod(sector, industry) {
  if (industry && LENDER_INDUSTRY.test(industry)) return "lender";
  if (sector === FINANCIAL_SECTOR) return "financial";
  return "standard";
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function inverse(multiple) {
  const m = num(multiple);
  if (m == null) return null;
  return m > 0 ? 1 / m : LOSS;
}

/** Raw "higher is better" metrics for one stock's fundamentals. */
function rawMetrics(f) {
  if (!f) return {};
  const pe = num(f.trailingPE);
  const margin = num(f.profitMargins);
  // Yahoo omits trailing P/E when earnings are negative.
  const earningsYield = pe != null ? inverse(pe) : (margin != null && margin < 0 ? LOSS : null);
  const de = num(f.debtToEquity);
  return {
    earningsYield,
    bookYield:   inverse(f.priceToBook),
    ebitdaYield: inverse(f.enterpriseToEbitda),
    roe:         num(f.returnOnEquity),
    roa:         num(f.returnOnAssets),
    margin,
    lowLeverage: de != null ? -de : null,
    earningsGrowth: num(f.earningsGrowth),
    revenueGrowth:  num(f.revenueGrowth),
  };
}

/** Mid-rank percentile (0–100) of x among values (ties share the average rank). */
function percentile(x, values) {
  if (values.length <= 1) return 50;
  let below = 0, equal = 0;
  for (const v of values) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  const rank = below + (equal - 1) / 2;
  return (rank / (values.length - 1)) * 100;
}

function weighted(parts, weights) {
  let sum = 0, wsum = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (parts[k] != null) { sum += parts[k] * w; wsum += w; }
  }
  return wsum > 0 ? Math.round(sum / wsum) : null;
}

const RANKED_METRICS = ["earningsYield", "bookYield", "ebitdaYield", "roe", "roa",
                        "margin", "lowLeverage", "earningsGrowth", "revenueGrowth"];

/**
 * Attach `valuation` to every stock that has fundamentals.
 * stocks: [{ symbol, sector, fundamentals }]. Mutates and returns the count scored.
 */
function scoreValuations(stocks) {
  const rows = [];
  for (const s of stocks) {
    if (!s.fundamentals) continue;
    const method = valuationMethod(s.sector, s.fundamentals.industry);
    rows.push({ s, method, group: `${s.sector}|${method}`, m: rawMetrics(s.fundamentals) });
  }

  // metric values per peer group and per method (fallback pool)
  const pools = new Map();
  const push = (key, metric, v) => {
    const k = `${key}#${metric}`;
    if (!pools.has(k)) pools.set(k, []);
    pools.get(k).push(v);
  };
  for (const r of rows) {
    for (const metric of RANKED_METRICS) {
      const v = r.m[metric];
      if (v == null) continue;
      push(r.group, metric, v);
      push(`*|${r.method}`, metric, v);
    }
  }
  const peerValues = (r, metric) => {
    const group = pools.get(`${r.group}#${metric}`) ?? [];
    return group.length >= MIN_PEERS ? group : (pools.get(`*|${r.method}#${metric}`) ?? []);
  };

  const groupSizes = new Map();
  for (const r of rows) groupSizes.set(r.group, (groupSizes.get(r.group) ?? 0) + 1);

  for (const r of rows) {
    const pct = {};
    for (const metric of RANKED_METRICS) {
      const v = r.m[metric];
      if (v != null) pct[metric] = percentile(v, peerValues(r, metric));
    }
    const growthParts = [pct.earningsGrowth, pct.revenueGrowth].filter((v) => v != null);
    pct.growth = growthParts.length ? growthParts.reduce((a, b) => a + b, 0) / growthParts.length : null;

    const w = WEIGHTS[r.method];
    const valueScore = weighted(pct, w.value);
    const qualityScore = weighted(pct, w.quality);

    r.s.valuation = {
      method: r.method,
      peerGroup: r.s.sector,
      peers: groupSizes.get(r.group),
      valueScore,
      qualityScore,
      components: Object.fromEntries(
        Object.entries(pct).filter(([, v]) => v != null).map(([k, v]) => [k, Math.round(v)])
      ),
    };
  }
  return rows.length;
}

/** Positive-magnitude penalty for stocks that are expensive AND weak vs peers. */
function valuationPenalty(valuation) {
  if (!valuation || valuation.valueScore == null || valuation.qualityScore == null) return 0;
  return valuation.valueScore < PENALTY_VALUE_MAX && valuation.qualityScore < PENALTY_QUALITY_MAX
    ? VALUATION_PENALTY
    : 0;
}

function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * Sector-level pricing vs the whole market, today only (no history yet).
 * Uses profitable names' trailing P/E; sectors need MIN_PEERS of them.
 * Returns { marketPE, sectors: [...] } sorted cheapest-relative first.
 */
function sectorValuationSummary(stocks) {
  const withF = stocks.filter((s) => s.fundamentals);
  const pe = (s) => {
    const v = num(s.fundamentals.trailingPE);
    return v != null && v > 0 ? v : null;
  };
  const marketPE = median(withF.map(pe));
  if (marketPE == null) return { marketPE: null, sectors: [] };

  const bySector = new Map();
  for (const s of withF) {
    if (!bySector.has(s.sector)) bySector.set(s.sector, []);
    bySector.get(s.sector).push(s);
  }

  const out = [];
  for (const [sector, list] of bySector) {
    const pes = list.map(pe).filter((v) => v != null);
    if (pes.length < MIN_PEERS) continue;
    const medianPE = median(pes);
    const ratio = medianPE / marketPE;
    out.push({
      sector,
      stocks: list.length,
      medianPE: round1(medianPE),
      medianPB: round1(median(list.map((s) => {
        const v = num(s.fundamentals.priceToBook);
        return v != null && v > 0 ? v : null;
      }))),
      medianROE: round1(median(list.map((s) => num(s.fundamentals.returnOnEquity)))),
      peVsMarket: Math.round(ratio * 100) / 100,
      label: ratio < 0.8 ? "cheaper" : ratio > 1.25 ? "pricier" : "in line",
    });
  }
  out.sort((a, b) => a.peVsMarket - b.peVsMarket);
  return { marketPE: round1(marketPE), sectors: out };
}

module.exports = {
  scoreValuations,
  valuationPenalty,
  sectorValuationSummary,
  valuationMethod,
  rawMetrics,
  percentile,
  VALUATION_PENALTY,
};
