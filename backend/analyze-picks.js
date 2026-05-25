"use strict";
/**
 * Fetch top 10 MF picks from Supabase, generate AI investment rationale
 * for each using Claude, then store results back in pick_rationales table.
 *
 * Usage:
 *   node backend/analyze-picks.js
 *
 * Requires in backend/.env:
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_KEY=...
 */

require("dotenv").config();
const Anthropic      = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const WebSocket      = require("ws");

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

// ─── Momentum score (same as Picks.jsx) ──────────────────────────────────────
function momentumScore(fund, catZ) {
  return (fund.ret1w ?? 0) * 0.4
       + (fund.ret1m ?? 0) * 0.3
       + (fund.ret3m ?? 0) * 0.2
       + (catZ       ?? 0) * 5 * 0.1;
}

function buildTopPicks(mfData) {
  // One best fund per category (mirrors MfPicks UI) — no slice
  return mfData.categories
    .map((cat) => {
      const catZ = cat.median.z1w ?? 0;
      const top  = [...cat.funds]
        .map((f) => ({ ...f, score: momentumScore(f, catZ), catZ, category: cat.category, catMedian: cat.median }))
        .sort((a, b) => b.score - a.score)[0];
      return top ?? null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function fmtPct(v) {
  if (v == null) return "N/A";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtN(v, d = 2) { return v != null ? v.toFixed(d) : "N/A"; }

function fundSummary(f) {
  return [
    `Fund: ${f.label}`,
    `Category: ${f.category}`,
    `Returns — 1W: ${fmtPct(f.ret1w)}, 1M: ${fmtPct(f.ret1m)}, 3M: ${fmtPct(f.ret3m)}, 6M: ${fmtPct(f.ret6m)}, 1Y: ${fmtPct(f.ret1y)}`,
    `Long-term CAGR — 3Y: ${fmtPct(f.cagr3y)}, 5Y: ${fmtPct(f.cagr5y)}, 10Y: ${fmtPct(f.cagr10y)}`,
    `Risk — Sharpe: ${fmtN(f.sharpe)}, Max Drawdown: ${fmtPct(f.maxDd)}, Consistency: ${fmtN(f.consistency, 0)}%, Alpha 5Y: ${fmtPct(f.alpha5y)}`,
    `Category median 1W z-score: ${fmtN(f.catZ)} (≥2 = unusually strong week, ≤-2 = unusually weak)`,
    `Momentum score: ${f.score.toFixed(2)}`,
  ].join("\n");
}

async function analyzePickPair(pick, nextPick, rank) {
  const prompt = `You are a sharp Indian mutual fund analyst. A momentum-based algorithm has ranked mutual funds by short-term return strength and z-score. Your job is to provide a concise, grounded investment rationale for the top pick vs the next-ranked alternative.

TOP PICK (Rank #${rank}):
${fundSummary(pick)}

NEXT PICK (Rank #${rank + 1}):
${nextPick ? fundSummary(nextPick) : "None (this is the last pick)"}

Respond ONLY with a JSON object (no markdown, no explanation outside the JSON) with exactly this structure:
{
  "macro_theme": "1-2 sentences on the macro or sectoral tailwind driving this category right now",
  "bull_case": ["reason 1", "reason 2", "reason 3"],
  "bear_case": ["risk 1", "risk 2"],
  "vs_next_pick": "2-3 sentences explaining why the top pick is the stronger bet vs the next pick right now, or if they serve different risk profiles",
  "verdict": "Strong Buy | Buy | Hold | Avoid",
  "confidence": "High | Medium | Low",
  "confidence_reason": "1 sentence on what drives the confidence level"
}

Be specific to the actual fund category and India's market context. Avoid generic statements.`;

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 800,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = response.content[0].text.trim();
  return JSON.parse(text);
}

async function main() {
  console.log("Fetching mf_radar from Supabase…");
  const { data: row, error } = await supabase
    .from("radar_cache")
    .select("data")
    .eq("key", "mf_radar")
    .single();
  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);

  const picks = buildTopPicks(row.data);
  console.log(`Top ${picks.length} picks:`);
  picks.forEach((p, i) => console.log(`  #${i + 1} ${p.label} (${p.category}) score=${p.score.toFixed(2)}`));
  console.log();

  const today = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < picks.length; i++) {
    const pick     = picks[i];
    const nextPick = picks[i + 1] ?? null;
    console.log(`Analyzing #${i + 1}: ${pick.label}…`);

    try {
      const analysis = await analyzePickPair(pick, nextPick, i + 1);

      const { error: upsertErr } = await supabase
        .from("pick_ai_rationales")
        .upsert({
          fund_code:    pick.code,
          fund_name:    pick.label,
          category:     pick.category,
          rank:         i + 1,
          analysis,
          generated_at: new Date().toISOString(),
        }, { onConflict: "fund_code" });

      if (upsertErr) {
        console.error(`  ✗ Supabase upsert failed: ${upsertErr.message}`);
      } else {
        console.log(`  ✓ Saved | verdict: ${analysis.verdict} | confidence: ${analysis.confidence}`);
        console.log(`    macro: ${analysis.macro_theme.slice(0, 80)}…`);
      }
    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
