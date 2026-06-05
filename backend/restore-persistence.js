"use strict";
/**
 * One-time script: restore daysInTop50 / daysInTop100 persistence counters
 * that were wiped when a failed scan (0 stocks) overwrote Supabase.
 *
 * What it does:
 *   Reads the current stock_picks from Supabase, finds every stock currently
 *   in top 50 that has daysInTop50 < RECOVER_DAYS, and bumps it to RECOVER_DAYS.
 *   This restores Core visibility without requiring 7 more daily runs.
 *
 * Safe to re-run — it only raises counters that are below the target, never lowers them.
 *
 * Usage:
 *   node backend/restore-persistence.js           # bumps to 7 (default)
 *   node backend/restore-persistence.js --days 10 # bumps to custom value
 *   node backend/restore-persistence.js --dry-run # preview without writing
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const WebSocket        = require("ws");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes("--dry-run");
const daysArg  = args.includes("--days") ? parseInt(args[args.indexOf("--days") + 1], 10) : NaN;
const RECOVER_DAYS = isFinite(daysArg) && daysArg > 0 ? daysArg : 7;

async function main() {
  console.log(`restore-persistence — recovering daysInTop50 to ${RECOVER_DAYS}${DRY_RUN ? " [DRY RUN]" : ""}`);

  const { data: row, error } = await supabase
    .from("radar_cache").select("data, built_at").eq("key", "stock_picks").single();

  if (error || !row?.data) {
    console.error("Failed to load stock_picks:", error?.message ?? "no row");
    process.exit(1);
  }

  const stored = row.data;
  const picks  = stored.picks ?? [];
  const all    = stored.all   ?? [];

  if (!picks.length) {
    console.error("stock_picks.picks is empty — nothing to restore");
    process.exit(1);
  }

  let bumped = 0;

  for (const p of all) {
    const inTop50  = p.rank != null && p.rank <= 50;
    const inTop100 = p.rank != null && p.rank <= 100;
    if (inTop50 && (p.daysInTop50 ?? 0) < RECOVER_DAYS) {
      console.log(`  bump ${p.symbol} (rank ${p.rank}) daysInTop50: ${p.daysInTop50 ?? 0} → ${RECOVER_DAYS}`);
      p.daysInTop50 = RECOVER_DAYS;
      bumped++;
    }
    if (inTop100 && (p.daysInTop100 ?? 0) < RECOVER_DAYS) {
      p.daysInTop100 = RECOVER_DAYS;
    }
  }

  // Mirror changes into picks (top 50 slice)
  const allMap = Object.fromEntries(all.map((p) => [p.symbol, p]));
  for (const p of picks) {
    if (allMap[p.symbol]) {
      p.daysInTop50  = allMap[p.symbol].daysInTop50;
      p.daysInTop100 = allMap[p.symbol].daysInTop100;
    }
  }

  console.log(`\n${bumped} stocks in top 50 bumped to daysInTop50 = ${RECOVER_DAYS}`);

  if (DRY_RUN) {
    console.log("[dry-run] No changes written.");
    return;
  }

  const { error: upsertErr } = await supabase
    .from("radar_cache")
    .upsert({ key: "stock_picks", data: stored, built_at: new Date().toISOString() });

  if (upsertErr) {
    console.error("Supabase upsert failed:", upsertErr.message);
    process.exit(1);
  }

  console.log(`✓ stock_picks updated — ${bumped} Core picks restored.`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
