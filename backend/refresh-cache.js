"use strict";

/**
 * Run by GitHub Actions to build momentum data and persist to Supabase.
 * Usage: node refresh-cache.js [all|mf|stocks]
 */

require("dotenv").config();
const { createClient }              = require("@supabase/supabase-js");
const { getLeaderboard }            = require("./momentum");
const { getBenchmarks }             = require("./mf_benchmarks");
const { getStockLeaderboard }       = require("./stock_momentum");
const { getEtfLeaderboard }         = require("./etf_momentum");
const { buildStockDetail, buildMfDetail, buildEtfDetail, buildBatch } = require("./instrument_details");
const { buildSignalsLeaderboard, eodSignalScore }   = require("./stock_signals");
const { getDeliveryMap }            = require("./stock_bhavcopy");
const { getDiscovery, buildSymbolBonuses } = require("./nse_discovery");
const { getNifty500 }               = require("./nifty500_universe");
const { getNiftyReturns }           = require("./nifty_benchmark");
const { getFundamentalsBatch }      = require("./yahoo_fundamentals");
const { generateRationales }        = require("./generate-rationales");
const { generateStockRationales }   = require("./generate-stock-rationales");
const WebSocket                     = require("ws");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth:     { persistSession: false },
    realtime: { transport: WebSocket },
  }
);

const target = process.argv[2] || "all";

async function upsert(key, data) {
  const { error } = await supabase
    .from("radar_cache")
    .upsert({ key, data, built_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase upsert failed for ${key}: ${error.message}`);
  const kb = (JSON.stringify(data).length / 1024).toFixed(1);
  console.log(`✓ ${key} saved (${kb} KB)`);
}

async function main() {
  console.log(`Target: ${target} | ${new Date().toISOString()}`);

  if (target === "all" || target === "mf") {
    console.log("Fetching NSE category benchmarks…");
    let benchmarks = null;
    try {
      benchmarks = await getBenchmarks({ force: true });
      const fetched = Object.keys(benchmarks.raw ?? {}).length;
      console.log(`  ✓ ${fetched} indices fetched`);
    } catch (e) {
      console.warn(`  ⚠ benchmark fetch failed: ${e.message}`);
    }

    console.log("Building MF radar…");
    const mf = await getLeaderboard({ force: true, benchmarks });
    await upsert("mf_radar", mf);
    console.log(`  ${mf.categories.length} categories processed`);
    if (mf.warnings?.length) console.warn("  warnings:", mf.warnings);

    console.log("Generating rule-based rationales…");
    const today      = new Date().toISOString().slice(0, 10);
    const rationales = generateRationales(mf, 10);
    for (const r of rationales) {
      const { error } = await supabase
        .from("pick_rationales")
        .upsert({ ...r, generated_at: new Date().toISOString(), run_date: today },
                { onConflict: "fund_code,run_date" });
      if (error) console.warn(`  ✗ rationale for ${r.fund_name}: ${error.message}`);
      else       console.log(`  ✓ #${r.rank} ${r.fund_name} → ${r.analysis.verdict}`);
    }
  }

  if (target === "all" || target === "stocks") {
    console.log("Building stock radar (curated 84-stock sector view)…");
    const stocks = await getStockLeaderboard({ force: true });
    await upsert("stock_radar", stocks);
    console.log(`  ${stocks.sectors.length} sectors processed`);
    if (stocks.warnings?.length) console.warn("  warnings:", stocks.warnings);

    console.log("Fetching NSE bhavcopy for delivery %…");
    let deliveryMap = {};
    try {
      const bhav = await getDeliveryMap({ force: true });
      deliveryMap = bhav.symbols ?? {};
      console.log(`  ✓ bhavcopy for ${bhav.date} (${bhav.count} symbols)`);
    } catch (e) {
      console.warn(`  ⚠ bhavcopy unavailable: ${e.message}`);
    }

    console.log("Fetching NSE discovery feeds…");
    let discovery = null, discBonuses = {};
    try {
      discovery = await getDiscovery({ force: true });
      discBonuses = buildSymbolBonuses(discovery);
      console.log(`  ✓ 52wHi=${discovery.highs52w.length} gainers=${discovery.topGainers.length} ` +
                  `bulk=${discovery.bulkDeals.length} block=${discovery.blockDeals.length} ` +
                  `oiLong=${discovery.oiBuildup.longBuildup.length}`);
    } catch (e) {
      console.warn(`  ⚠ discovery feeds unavailable: ${e.message}`);
    }

    console.log("Loading Nifty 500 universe…");
    let universe;
    try {
      universe = await getNifty500();
      console.log(`  ✓ ${universe.length} stocks in Nifty 500`);
    } catch (e) {
      console.warn(`  ⚠ Nifty 500 fetch failed (${e.message}) — falling back to curated 84-stock list`);
    }

    console.log("Fetching Nifty 50 benchmark for relative-strength…");
    let niftyReturns = null;
    try {
      niftyReturns = await getNiftyReturns();
      console.log(`  ✓ Nifty 1M=${niftyReturns.ret1m?.toFixed(1)}% 3M=${niftyReturns.ret3m?.toFixed(1)}% 1Y=${niftyReturns.ret1y?.toFixed(1)}%`);
    } catch (e) {
      console.warn(`  ⚠ Nifty benchmark unavailable: ${e.message}`);
    }

    // ── Fetch previous day's EOD scores for smoothing ─────────────────────
    // Use eodCompositeScore (not compositeScore) — intraday runs overwrite
    // compositeScore during the day, so reading it here would mix today's
    // intraday-updated values into the EMA instead of clean EOD-to-EOD blending.
    console.log("Fetching previous stock_picks for score smoothing + persistence…");
    let prevScoreMap = {};                       // symbol → prev EOD composite score
    let prevPersistenceMap = {};                 // symbol → { rank, daysInTop50, daysInTop100 }
    try {
      const { data: prevRow } = await supabase
        .from("radar_cache").select("data").eq("key", "stock_picks").single();
      if (prevRow?.data) {
        for (const p of (prevRow.data.picks ?? [])) {
          const score = p.eodCompositeScore ?? p.compositeScore;
          if (p.symbol && score != null) prevScoreMap[p.symbol] = score;
          if (p.symbol) {
            prevPersistenceMap[p.symbol] = {
              rank:          p.rank,
              daysInTop50:   p.daysInTop50  ?? 0,
              daysInTop100:  p.daysInTop100 ?? 0,
            };
          }
        }
        for (const p of (prevRow.data.all ?? [])) {
          const score = p.eodCompositeScore ?? p.compositeScore;
          if (p.symbol && score != null && !(p.symbol in prevScoreMap))
            prevScoreMap[p.symbol] = score;
          if (p.symbol && !(p.symbol in prevPersistenceMap)) {
            prevPersistenceMap[p.symbol] = {
              rank:          p.rank,
              daysInTop50:   p.daysInTop50  ?? 0,
              daysInTop100:  p.daysInTop100 ?? 0,
            };
          }
        }
        console.log(`  ✓ loaded prev EOD scores for ${Object.keys(prevScoreMap).length} stocks · persistence for ${Object.keys(prevPersistenceMap).length}`);
      }
    } catch (e) {
      console.warn(`  ⚠ could not load previous scores: ${e.message}`);
    }

    console.log("Computing stock signals across universe (this can take a few minutes)…");
    const signals = await buildSignalsLeaderboard({
      deliveryMap, discBonuses, niftyReturns, universe, concurrency: 6,
    });

    console.log("Fetching fundamentals for top 200 picks…");
    let fundamentals = {};
    try {
      const topSymbols = signals.all.slice(0, 200).map((p) => p.symbol);
      fundamentals = await getFundamentalsBatch(topSymbols, { concurrency: 5 });
      console.log(`  ✓ fundamentals for ${Object.values(fundamentals).filter(Boolean).length} of ${topSymbols.length}`);
    } catch (e) {
      console.warn(`  ⚠ fundamentals unavailable: ${e.message}`);
    }

    // Attach fundamentals + small mcap penalty + quality bonus
    for (const p of signals.all) {
      const f = fundamentals[p.symbol];
      if (!f) continue;
      p.fundamentals = f;
      if (f.marketCapCr != null && f.marketCapCr < 500) {
        // Penalize tiny micro-caps to keep picks investable
        p.compositeScore = Math.max(0, p.compositeScore - 10);
      } else if (f.marketCapCr != null && f.marketCapCr >= 5000) {
        // Large-cap quality bonus
        p.compositeScore = Math.min(100, p.compositeScore + 3);
      }
      // Earnings-growth bonus
      if (f.earningsGrowth != null && f.earningsGrowth >= 20) {
        p.compositeScore = Math.min(100, p.compositeScore + 5);
      }
      // High RoE bonus
      if (f.returnOnEquity != null && f.returnOnEquity >= 20) {
        p.compositeScore = Math.min(100, p.compositeScore + 3);
      }
    }

    // ── Store EOD base score (before smoothing) for intraday anchoring ────────
    for (const p of signals.all) {
      p.eodBaseScore = Math.max(0, Math.min(100, Math.round(eodSignalScore(p))));
    }

    // ── EOD-to-EOD score smoothing (EMA α=0.6) ────────────────────────────
    // Blends today's raw EOD score with yesterday's EOD score so a stock
    // needs consistent signals across days to hold a top rank.
    //   eodSmoothed = 0.6 × todayRaw + 0.4 × prevEodSmoothed
    // This is pure EOD-to-EOD: prevScoreMap holds eodCompositeScore values,
    // so intraday updates during the day don't leak into this calculation.
    // New stocks (no prior entry) enter at full raw score — no penalty.
    let smoothedCount = 0;
    for (const p of signals.all) {
      p.rawScore = p.compositeScore;          // preserve today's raw signal score
      const prev = prevScoreMap[p.symbol];
      if (prev != null) {
        p.compositeScore = Math.round(0.6 * p.rawScore + 0.4 * prev);
        smoothedCount++;
      }
      // else new stock: compositeScore stays as rawScore (no prior to blend with)
      p.eodCompositeScore = p.compositeScore;  // fixed anchor used by intraday runs
    }
    console.log(`  ✓ score smoothing applied (EMA α=0.6): ${smoothedCount} stocks blended with yesterday`);

    // ── Incumbent hysteresis: +5 bonus to stocks that were in yesterday's top 50 ──
    // Prevents 50↔51 boundary churn. Stocks legitimately losing momentum will still
    // fall enough for +5 not to save them. Bonus is stored separately for transparency.
    let incumbentCount = 0;
    for (const p of signals.all) {
      const prev = prevPersistenceMap[p.symbol];
      const wasTop50  = prev && prev.rank != null && prev.rank <= 50;
      const wasTop100 = prev && prev.rank != null && prev.rank <= 100;
      p.incumbentBonus = wasTop50 ? 5 : 0;
      if (wasTop50) {
        p.compositeScore = Math.min(100, p.compositeScore + 5);
        incumbentCount++;
      }
      // Track persistence for downstream sort + UI badges
      p.yesterdayRank = prev?.rank ?? null;
      p.wasInTop50  = !!wasTop50;
      p.wasInTop100 = !!wasTop100;
      p.prevDaysInTop50  = prev?.daysInTop50  ?? 0;
      p.prevDaysInTop100 = prev?.daysInTop100 ?? 0;
    }
    console.log(`  ✓ incumbent hysteresis: +5 applied to ${incumbentCount} stocks from yesterday's top 50`);

    // Re-sort after fundamental adjustments + smoothing + hysteresis
    signals.all.sort((a, b) => b.compositeScore - a.compositeScore || b.signalCount - a.signalCount);
    signals.all.forEach((s, i) => { s.rank = i + 1; });

    // ── Persistence counters (using FINAL ranks) ──────────────────────────────
    // daysInTop50  = consecutive days in current top 50 (including today)
    // daysInTop100 = consecutive days in current top 100 (including today)
    // rankDelta    = positive if moved up, negative if moved down
    // newToday     = true if not in yesterday's top 200
    for (const p of signals.all) {
      const inTop50  = p.rank <= 50;
      const inTop100 = p.rank <= 100;
      p.daysInTop50  = inTop50  ? p.prevDaysInTop50  + 1 : 0;
      p.daysInTop100 = inTop100 ? p.prevDaysInTop100 + 1 : 0;
      p.rankDelta    = p.yesterdayRank != null ? p.yesterdayRank - p.rank : null;
      p.newToday     = p.yesterdayRank == null && inTop100;
      // Cleanup transient fields
      delete p.prevDaysInTop50;
      delete p.prevDaysInTop100;
      delete p.wasInTop50;
      delete p.wasInTop100;
    }
    const coreCount = signals.all.filter((p) => p.rank <= 50 && p.daysInTop50 >= 7).length;
    console.log(`  ✓ persistence tracked: ${coreCount} of top 50 are Core (≥7 days)`);

    signals.picks = signals.all.slice(0, 50);

    await upsert("stock_picks", {
      asOf:      signals.asOf,
      universe:  signals.universe,
      scanned:   signals.scanned,
      picks:     signals.picks,
      all:       signals.all.slice(0, 200),     // top 200 only — cache size
      discovery: discovery ?? null,
      niftyReturns,
      warnings:  signals.warnings.slice(0, 20),
    });
    console.log(`  ✓ ${signals.picks.length} top picks ranked (${signals.scanned} of ${signals.universe} stocks scanned)`);
    if (signals.warnings?.length) console.warn(`  warnings (${signals.warnings.length} total, first 5):`, signals.warnings.slice(0, 5));

    console.log("Generating rule-based stock rationales…");
    const today = new Date().toISOString().slice(0, 10);
    const stockRationales = generateStockRationales(signals.picks, 25);
    for (const r of stockRationales) {
      const { error } = await supabase
        .from("stock_pick_rationales")
        .upsert(
          { ...r, generated_at: new Date().toISOString(), run_date: today },
          { onConflict: "symbol,run_date" }
        );
      if (error) console.warn(`  ✗ rationale for ${r.symbol}: ${error.message}`);
      else       console.log(`  ✓ #${r.rank} ${r.stock_name} (score ${r.composite_score}) → ${r.analysis.verdict}`);
    }
  }

  if (target === "all" || target === "etf") {
    console.log("Building ETF picks (equity + commodity + international)…");
    const etfs = await getEtfLeaderboard({ force: true });
    await upsert("etf_picks", etfs);
    console.log(`  ${etfs.types.length} types processed (${etfs.types.reduce((s, t) => s + t.etfCount, 0)} ETFs)`);
    if (etfs.warnings?.length) console.warn(`  ${etfs.warnings.length} warnings (first 5):`, etfs.warnings.slice(0, 5));

    // Detail payloads for all ETFs
    const flatEtfs = etfs.types.flatMap((t) => t.etfs.map((e) => ({ ticker: e.ticker, label: e.label, type: e.type, aumCr: e.aumCr, ter: e.ter, benchmark: e.benchmark })));
    console.log(`Building detail payloads for ${flatEtfs.length} ETFs…`);
    const { results: etfDetails, errors: etfErr } = await buildBatch(flatEtfs, buildEtfDetail, { concurrency: 4, label: "ETF" });
    for (const d of etfDetails) {
      await upsert(`instrument_details.ETF.${d.id}`, d);
    }
    console.log(`  ✓ ${etfDetails.length} ETF detail payloads cached`);
    if (etfErr.length) console.warn(`  ${etfErr.length} detail errors (first 3):`, etfErr.slice(0, 3));
  }

  if (target === "all" || target === "details" || target === "stocks") {
    // Detail payloads for top 50 stock picks (uses the just-built stock_picks if present)
    console.log("Loading stock_picks for stock detail cache…");
    const { data: stockRow } = await supabase.from("radar_cache").select("data").eq("key", "stock_picks").single();
    if (stockRow?.data?.picks?.length) {
      const niftyReturns = stockRow.data.niftyReturns ?? null;
      const stockItems = stockRow.data.picks.slice(0, 50).map((p) => p.symbol.replace(/\.NS$/i, ""));
      console.log(`Building detail payloads for top ${stockItems.length} stocks…`);
      const { results, errors } = await buildBatch(
        stockItems,
        (sym) => buildStockDetail(sym, { niftyReturns }),
        { concurrency: 4, label: "STOCK" }
      );
      for (const d of results) {
        await upsert(`instrument_details.STOCK.${d.id}`, d);
      }
      console.log(`  ✓ ${results.length} stock detail payloads cached`);
      if (errors.length) console.warn(`  ${errors.length} detail errors (first 3):`, errors.slice(0, 3));
    } else {
      console.log("  no stock_picks row found — skipping stock details");
    }
  }

  if (target === "all" || target === "details" || target === "mf") {
    // Detail payloads for top 10 MFs per category from mf_radar
    console.log("Loading mf_radar for MF detail cache…");
    const { data: mfRow } = await supabase.from("radar_cache").select("data").eq("key", "mf_radar").single();
    if (mfRow?.data?.categories?.length) {
      const mfCodes = new Set();
      for (const cat of mfRow.data.categories) {
        for (const fund of (cat.funds ?? []).slice(0, 10)) {
          if (fund.code) mfCodes.add(fund.code);
        }
      }
      const codes = [...mfCodes];
      console.log(`Building detail payloads for ${codes.length} MFs…`);
      const { results, errors } = await buildBatch(codes, buildMfDetail, { concurrency: 3, label: "MF" });
      for (const d of results) {
        await upsert(`instrument_details.MF.${d.id}`, d);
      }
      console.log(`  ✓ ${results.length} MF detail payloads cached`);
      if (errors.length) console.warn(`  ${errors.length} detail errors (first 3):`, errors.slice(0, 3));
    } else {
      console.log("  no mf_radar row found — skipping MF details");
    }
  }

  console.log("Done.");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
