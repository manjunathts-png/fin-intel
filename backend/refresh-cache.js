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
const { loadMlBlend, applyMlBlend } = require("./ml_blend");
const { computeRegime, applyRegime } = require("./regime");
const { applySectorCap, sectorBreakdown } = require("./portfolio_guards");
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

    // ── Partial-result guard ──────────────────────────────────────────────────
    // If mfapi.in is down, most funds will fail with 502/timeout and we'd
    // overwrite a good cache with a near-empty one (as happened 2026-05-30).
    // Abort the upsert if fewer than 60% of funds loaded successfully.
    const totalFunds   = mf.categories.reduce((s, c) => s + c.funds.length, 0);
    const totalFailed  = mf.warnings?.length ?? 0;
    const totalExpected = totalFunds + totalFailed;
    const successRate  = totalExpected > 0 ? totalFunds / totalExpected : 1;
    if (successRate < 0.60) {
      console.error(
        `  ✗ MF radar aborted — only ${totalFunds}/${totalExpected} funds loaded ` +
        `(${(successRate * 100).toFixed(0)}% success rate < 60% threshold). ` +
        `Keeping existing cache. mfapi.in may be down.`
      );
      console.error(`  First failures: ${mf.warnings?.slice(0, 3).join(" | ")}`);
    } else {
      await upsert("mf_radar", mf);
      console.log(`  ${mf.categories.length} categories, ${totalFunds} funds (${totalFailed} failed)`);
      if (mf.warnings?.length) console.warn("  warnings:", mf.warnings.slice(0, 5));
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (successRate >= 0.60) {
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

    // ── Blend in the ML model (gated on out-of-sample edge) ───────────────────
    // The LightGBM forward-return model is a separate alpha source. It only moves
    // the score once it beats chance (CV AUC ≥ gate); a coin-flip model gets
    // weight 0 and leaves picks untouched. Folded in before smoothing so the EOD
    // anchor (eodCompositeScore) carries the ML component through intraday runs.
    try {
      const mlBlend = await loadMlBlend(supabase);
      const blended = applyMlBlend(signals.all, mlBlend);
      const m = mlBlend.meta || {};
      console.log(
        `  ${m.active ? "✓" : "○"} ML blend: ${m.reason}` +
        (m.cvAuc != null ? ` (AUC=${m.cvAuc.toFixed(3)}, w=${mlBlend.weight}, ${blended} stocks)` : "")
      );
    } catch (e) {
      console.warn(`  ⚠ ML blend skipped: ${e.message}`);
    }

    // ── Market-regime filter ──────────────────────────────────────────────────
    // In a weak/narrow tape, dock falling-knife names so picks concentrate in
    // resilient leaders. Applied before smoothing so it persists via the anchor.
    // VIX + FII flows (written daily by ml/macro_features.py into stock_features)
    // make the regime adaptive: stress amplifies the overextension docks.
    let macroSnap = null;
    try {
      const { data: macroRows } = await supabase
        .from("stock_features")
        .select("as_of_date,india_vix,fii_net_5d")
        .not("india_vix", "is", null)
        .order("as_of_date", { ascending: false })
        .limit(1);
      if (macroRows?.length) {
        const ageDays = (Date.now() - new Date(macroRows[0].as_of_date + "T00:00:00Z").getTime()) / 86400000;
        macroSnap = {
          indiaVix: macroRows[0].india_vix,
          fiiNet5d: macroRows[0].fii_net_5d,
          ageDays:  Math.round(ageDays * 10) / 10,
        };
        console.log(`  ✓ macro snapshot: VIX=${macroSnap.indiaVix} fiiNet5d=${macroSnap.fiiNet5d ?? "n/a"} (${macroSnap.ageDays}d old)`);
      }
    } catch (e) {
      console.warn(`  ⚠ macro snapshot unavailable: ${e.message}`);
    }
    const regimeInfo = computeRegime({ stocks: signals.all, niftyReturns, macro: macroSnap });
    const regimePenalized = applyRegime(signals.all, regimeInfo);
    console.log(
      `  ${regimeInfo.regime === "risk_off" ? "⚠" : "✓"} regime: ${regimeInfo.regime} ` +
      `(breadth=${regimeInfo.breadthPct}% above 200DMA, niftyRet3m=${regimeInfo.niftyRet3m ?? "n/a"}, ` +
      `vix=${regimeInfo.indiaVix ?? "n/a"}${regimeInfo.macroStale ? " [stale]" : ""}, fii5d=${regimeInfo.fiiNet5d ?? "n/a"}, ` +
      `${regimePenalized} names docked)`
    );

    // ── Store EOD base score (before EMA smoothing, after regime docking) ────
    // Used by refresh-intraday.js as the stable EOD component: eodBase + freshIntraday.
    // Must be set AFTER applyRegime so regime penalties persist through intraday runs;
    // if set from raw eodSignalScore the 12-pt dock collapses to ~4 pts during the day.
    for (const p of signals.all) {
      p.eodBaseScore = p.compositeScore;
    }

    // ── EOD-to-EOD score smoothing (EMA α=0.5) ────────────────────────────
    // Equal weight on today vs yesterday: a stock needs 2+ days of consistent
    // signals to move rank meaningfully. α was 0.6 (today-heavy); lowering to
    // 0.5 reduces day-to-day churn while still responding to genuine momentum.
    // New stocks (no prior entry) enter at full raw score — no penalty.
    let smoothedCount = 0;
    for (const p of signals.all) {
      p.rawScore = p.compositeScore;          // preserve today's raw signal score
      const prev = prevScoreMap[p.symbol];
      if (prev != null) {
        p.compositeScore = Math.round(0.5 * p.rawScore + 0.5 * prev);
        smoothedCount++;
      }
      // else new stock: compositeScore stays as rawScore (no prior to blend with)
      p.eodCompositeScore = p.compositeScore;  // fixed anchor used by intraday runs
    }
    console.log(`  ✓ score smoothing applied (EMA α=0.5): ${smoothedCount} stocks blended with yesterday`);

    // ── Incumbent hysteresis: +10 bonus to stocks that were in yesterday's top 50 ──
    // Prevents boundary churn. +10 means a stock needs a ~10pt net swing (roughly
    // 2 signals flipping) to lose its place, not just a single OI/delivery change.
    // Bonus was +5; raised to +10 to match typical single-signal volatility (~8–12pt).
    let incumbentCount = 0;
    for (const p of signals.all) {
      const prev = prevPersistenceMap[p.symbol];
      const wasTop50  = prev && prev.rank != null && prev.rank <= 50;
      const wasTop100 = prev && prev.rank != null && prev.rank <= 100;
      p.incumbentBonus = wasTop50 ? 10 : 0;
      if (wasTop50) {
        p.compositeScore = Math.min(100, p.compositeScore + 10);
        incumbentCount++;
      }
      // Track persistence for downstream sort + UI badges
      p.yesterdayRank = prev?.rank ?? null;
      p.wasInTop50  = !!wasTop50;
      p.wasInTop100 = !!wasTop100;
      p.prevDaysInTop50  = prev?.daysInTop50  ?? 0;
      p.prevDaysInTop100 = prev?.daysInTop100 ?? 0;
    }
    console.log(`  ✓ incumbent hysteresis: +10 applied to ${incumbentCount} stocks from yesterday's top 50`);

    // ── Entry gate: new stocks need a top-100 "audition" before entering top 50 ──
    // A stock with no prior history (or prior rank >100) is blocked from the top-50
    // slice. Without this, a single big signal day can rocket a newcomer straight
    // into the published list before it has proven sustained momentum.
    // We sort blocked stocks below all others, then restore their true compositeScore
    // so the stored data reflects actual momentum (just not a top-50 position).
    let entryGateDocked = 0;
    for (const p of signals.all) {
      p.blockedByEntryGate = !p.wasInTop100 && !p.wasInTop50;
      if (p.blockedByEntryGate) entryGateDocked++;
    }
    if (entryGateDocked > 0) {
      console.log(`  ✓ entry gate: ${entryGateDocked} first-time stocks blocked from top 50`);
    }

    // Rank comparator: blocked (entry-gate) stocks always sort after non-blocked
    // ones; within each group, by compositeScore then signalCount. Used for every
    // re-sort below so the entry gate survives later passes (e.g. the sector cap).
    const rankCompare = (a, b) => {
      if (a.blockedByEntryGate !== b.blockedByEntryGate)
        return a.blockedByEntryGate ? 1 : -1;
      return b.compositeScore - a.compositeScore || b.signalCount - a.signalCount;
    };

    // Re-sort after fundamental adjustments + smoothing + hysteresis + entry gate
    signals.all.sort(rankCompare);
    signals.all.forEach((s, i) => { s.rank = i + 1; });

    // ── Sector concentration cap (soft) ──────────────────────────────────────
    // Dock top-50 names beyond 30% from a single sector so one sector-wide
    // reversal can't take down the whole published list. Re-sort after — using
    // rankCompare so docking can't float a gated newcomer back into the top 50.
    const sectorDocked = applySectorCap(signals.all, { topN: 50 });
    if (sectorDocked > 0) {
      signals.all.sort(rankCompare);
      signals.all.forEach((s, i) => { s.rank = i + 1; });
    }
    const topSectors = sectorBreakdown(signals.all, 50).slice(0, 3)
      .map((s) => `${s.sector} ${s.pct}%`).join(", ");
    console.log(`  ✓ sector cap: ${sectorDocked} docked · top-50 mix: ${topSectors}`);

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
      delete p.blockedByEntryGate;
    }
    const coreCount = signals.all.filter((p) => p.rank <= 50 && p.daysInTop50 >= 7).length;
    console.log(`  ✓ persistence tracked: ${coreCount} of top 50 are Core (≥7 days)`);

    signals.picks = signals.all.slice(0, 50);

    // Guard: never overwrite Supabase with a near-empty scan — it would wipe out
    // persistence counters (daysInTop50) that took days to accumulate, making
    // Core picks disappear. Threshold is 50: low enough to allow the 158-stock
    // curated fallback to succeed even under heavy fetch failures, high enough
    // to catch truly broken scans (network down, empty universe, etc.).
    const MIN_SCAN_FOR_UPSERT = 50;
    if (signals.scanned < MIN_SCAN_FOR_UPSERT) {
      console.error(`  ✗ scan produced only ${signals.scanned} stocks (< ${MIN_SCAN_FOR_UPSERT} threshold) — skipping stock_picks upsert to preserve existing data`);
      console.error("  ✗ check data source connectivity and re-run once resolved");
    } else {
      await upsert("stock_picks", {
        asOf:      signals.asOf,
        universe:  signals.universe,
        scanned:   signals.scanned,
        picks:     signals.picks,
        all:       signals.all.slice(0, 200),     // top 200 only — cache size
        discovery: discovery ?? null,
        niftyReturns,
        regime:    regimeInfo,
        warnings:  signals.warnings.slice(0, 20),
      });
      console.log(`  ✓ ${signals.picks.length} top picks ranked (${signals.scanned} of ${signals.universe} stocks scanned)`);
      if (signals.warnings?.length) console.warn(`  warnings (${signals.warnings.length} total, first 5):`, signals.warnings.slice(0, 5));

      // ── Realized-P&L feedback loop: snapshot today's top 100 ─────────────
      // ml/track_pick_outcomes.py later backfills ret_5d/10d/21d from the
      // OHLCV cache. Without this snapshot there is no ground truth on
      // whether the published picks actually made money.
      try {
        const pickDate = new Date().toISOString().slice(0, 10);
        const histRows = signals.all.slice(0, 100).map((p) => ({
          pick_date:       pickDate,
          symbol:          p.symbol,
          rank:            p.rank,
          composite_score: p.compositeScore ?? null,
          eod_base_score:  p.eodBaseScore ?? null,
          ml_score:        p.mlScore ?? null,
          days_in_top50:   p.daysInTop50 ?? null,
        }));
        const { error: histErr } = await supabase
          .from("pick_history")
          .upsert(histRows, { onConflict: "pick_date,symbol" });
        if (histErr) console.warn(`  ⚠ pick_history snapshot failed: ${histErr.message} (run migrate_012?)`);
        else console.log(`  ✓ pick_history snapshot: ${histRows.length} rows for ${pickDate}`);
      } catch (e) {
        console.warn(`  ⚠ pick_history snapshot failed: ${e.message}`);
      }
    }

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
