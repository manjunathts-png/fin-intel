import { useEffect, useState } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";
import { trackEvent } from "../lib/analytics";
import PageFooter from "../components/PageFooter";
import InstrumentDrawer from "../components/InstrumentDrawer";

// ─── Constants ────────────────────────────────────────────────────────────────

const VERDICT_STYLE = {
  "Strong Buy": "bg-green-500/20 text-green-300 border-green-600/40",
  "Buy":        "bg-green-800/30 text-green-400 border-green-700/40",
  "Hold":       "bg-yellow-500/20 text-yellow-300 border-yellow-600/40",
  "Avoid":      "bg-red-500/20 text-red-300 border-red-600/40",
};
const CONFIDENCE_STYLE = {
  "High":   "text-green-400",
  "Medium": "text-yellow-400",
  "Low":    "text-red-400",
};

const CHIP_STYLE = {
  institutional:   "bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-600/50 font-bold",
  discovery:       "bg-pink-500/20 text-pink-200 border-pink-600/50",
  fno:             "bg-indigo-500/20 text-indigo-300 border-indigo-600/40",
  rs:              "bg-lime-500/20 text-lime-300 border-lime-600/40 font-semibold",
  volume:          "bg-orange-500/20 text-orange-300 border-orange-600/40",
  breakout:        "bg-green-500/20 text-green-300 border-green-600/40",
  trend:           "bg-emerald-500/20 text-emerald-200 border-emerald-600/40",
  indicator:       "bg-cyan-500/20 text-cyan-300 border-cyan-600/40",
  pattern:         "bg-purple-500/20 text-purple-300 border-purple-600/40",
  gap:             "bg-yellow-500/20 text-yellow-200 border-yellow-600/40",
  "rsi-oversold":  "bg-blue-500/20 text-blue-300 border-blue-600/40",
  "rsi-overbought":"bg-red-500/20 text-red-300 border-red-600/40",
  delivery:        "bg-teal-500/20 text-teal-300 border-teal-600/40",
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtMcap(cr) {
  if (cr == null) return null;
  if (cr >= 1e5)  return `₹${(cr / 1e5).toFixed(2)}L Cr`;
  return `₹${cr.toLocaleString("en-IN")} Cr`;
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ─── Analysis body ────────────────────────────────────────────────────────────

function AnalysisBody({ analysis }) {
  const verdictCls = VERDICT_STYLE[analysis.verdict] ?? "bg-gray-700/30 text-gray-300 border-gray-600/40";
  const confCls    = CONFIDENCE_STYLE[analysis.confidence] ?? "text-gray-400";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${verdictCls}`}>
          {analysis.verdict}
        </span>
        <span className={`text-xs font-medium ${confCls}`}>{analysis.confidence} confidence</span>
        <span className="text-xs text-gray-600">— {analysis.confidence_reason}</span>
      </div>
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Macro Theme</div>
        <p className="text-xs text-gray-300 leading-relaxed">{analysis.macro_theme}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-green-500">Bull Case</div>
          <ul className="space-y-1">
            {analysis.bull_case.map((pt, i) => (
              <li key={i} className="flex gap-2 text-xs text-gray-300">
                <span className="mt-0.5 shrink-0 text-green-500">↑</span>{pt}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-500">Bear Case</div>
          <ul className="space-y-1">
            {analysis.bear_case.map((pt, i) => (
              <li key={i} className="flex gap-2 text-xs text-gray-300">
                <span className="mt-0.5 shrink-0 text-red-500">↓</span>{pt}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {analysis.vs_next_pick && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-blue-500">vs Next Pick</div>
          <p className="text-xs text-gray-300 leading-relaxed">{analysis.vs_next_pick}</p>
        </div>
      )}
    </div>
  );
}

// ─── Rationale panels ─────────────────────────────────────────────────────────

function RationaleSection({ ruleBased, aiRationale }) {
  const [openRule, setOpenRule] = useState(false);
  const [openAi,   setOpenAi]   = useState(false);
  if (!ruleBased && !aiRationale) return null;

  return (
    <div className="space-y-2">
      {ruleBased && (
        <div>
          <button
            onClick={() => setOpenRule((o) => !o)}
            className="flex w-full items-center gap-2 rounded-xl border border-gray-700/60 bg-gray-800/40 px-3 py-2 text-left text-xs font-medium text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition"
          >
            <span className="text-gray-600">⚙</span>
            <span className="flex-1">Daily Analysis</span>
            <span className={`font-semibold ${CONFIDENCE_STYLE[ruleBased.analysis.confidence] ?? "text-gray-500"}`}>
              {ruleBased.analysis.verdict}
            </span>
            <span>{openRule ? "▲" : "▼"}</span>
          </button>
          {openRule && (
            <div className="mt-1 rounded-xl border border-gray-700/40 bg-gray-800/30 p-4">
              <AnalysisBody analysis={ruleBased.analysis} />
              <div className="mt-3 text-[10px] text-gray-700">⚙ Rule-based · refreshes daily · Not financial advice</div>
            </div>
          )}
        </div>
      )}
      {aiRationale && (
        <div>
          <button
            onClick={() => setOpenAi((o) => !o)}
            className="flex w-full items-center gap-2 rounded-xl border border-purple-800/50 bg-purple-900/10 px-3 py-2 text-left text-xs font-medium text-purple-300 hover:bg-purple-900/20 transition"
          >
            <span>✦</span>
            <span className="flex-1">AI Analysis</span>
            <span className="text-purple-500 font-normal">{fmtDate(aiRationale.generated_at)}</span>
            <span className={`font-semibold ${CONFIDENCE_STYLE[aiRationale.analysis.confidence] ?? "text-gray-500"}`}>
              {aiRationale.analysis.verdict}
            </span>
            <span>{openAi ? "▲" : "▼"}</span>
          </button>
          {openAi && (
            <div className="mt-1 rounded-xl border border-purple-800/40 bg-purple-900/10 p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="rounded bg-purple-900/50 px-2 py-0.5 text-[10px] font-semibold text-purple-300">
                  ✦ AI Analysis
                </span>
                <span className="text-[10px] text-purple-500 font-medium">Generated {fmtDate(aiRationale.generated_at)}</span>
              </div>
              <AnalysisBody analysis={aiRationale.analysis} />
              <div className="mt-3 text-[10px] text-purple-900/80">Not financial advice</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Score badge ──────────────────────────────────────────────────────────────

function ScoreBadge({ score }) {
  const color = score >= 60 ? "from-green-700 to-green-500"
              : score >= 40 ? "from-yellow-700 to-yellow-500"
              : score >= 25 ? "from-blue-700 to-blue-500"
              :               "from-gray-700 to-gray-600";
  return (
    <div className={`rounded-lg bg-gradient-to-br ${color} px-2.5 py-1 text-center min-w-[58px]`}>
      <div className="text-base font-bold text-white tabular-nums leading-none">{score}</div>
      <div className="text-[8px] text-white/70 uppercase tracking-wider">score</div>
    </div>
  );
}

// ─── Technicals cell ──────────────────────────────────────────────────────────

function Tech({ label, val, fmt, color }) {
  return (
    <div className="rounded-lg bg-gray-800/40 px-2 py-1.5">
      <div className="text-[9px] text-gray-600 uppercase tracking-wider">{label}</div>
      <div className={`text-xs font-semibold tabular-nums ${color}`}>{fmt(val)}</div>
    </div>
  );
}

// ─── Stock Pick Card — Phase 2 three-tier disclosure ──────────────────────────
//
// Tier 1 (default): rank · name · sector · verdict · score · price · "N signals" brief
// Tier 2 (▾):       + signal chips + fundamentals + technicals + rationale

// Filter tab component used by the Core / Tactical / All selector
function FilterTab({ active, onClick, activeCls, icon, label, count, hint }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
        active
          ? activeCls
          : "border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600 hover:text-gray-200"
      }`}
      title={hint}
    >
      <span>{icon}</span>
      <span>{label}</span>
      <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${active ? "bg-white/20" : "bg-gray-800 text-gray-500"}`}>
        {count}
      </span>
    </button>
  );
}

// Stability chip — shows how long a stock has held its top-50 spot
function StabilityChip({ pick }) {
  const days = pick.daysInTop50;
  const newToday = pick.newToday;
  const delta = pick.rankDelta;

  // New today: brand-new entry
  if (newToday) {
    return (
      <span className="rounded-full border border-blue-700/40 bg-blue-900/30 px-2 py-0.5 text-[10px] font-bold text-blue-300">
        🆕 New today
      </span>
    );
  }

  // Core: stable for 7+ days
  if (days != null && days >= 14) {
    return (
      <span className="rounded-full border border-emerald-700/40 bg-emerald-900/30 px-2 py-0.5 text-[10px] font-bold text-emerald-300" title="In top 50 for 14+ trading days">
        📌 Core · {days}d
      </span>
    );
  }
  if (days != null && days >= 7) {
    return (
      <span className="rounded-full border border-green-700/40 bg-green-900/30 px-2 py-0.5 text-[10px] font-bold text-green-300" title="In top 50 for 7+ trading days">
        📌 Core · {days}d
      </span>
    );
  }
  if (days != null && days >= 1) {
    // Tactical: < 7 days
    return (
      <span className="rounded-full border border-amber-700/40 bg-amber-900/20 px-2 py-0.5 text-[10px] font-bold text-amber-300" title="Recent entry, not yet 'Core'">
        ⚡ Tactical · {days}d
      </span>
    );
  }
  return null;
}

// Rank delta chip — shows up/down movement vs yesterday
function RankDeltaChip({ delta }) {
  if (delta == null || delta === 0) return null;
  if (delta > 0) {
    return (
      <span className="rounded border border-green-700/40 bg-green-900/20 px-1.5 py-0.5 text-[10px] font-bold text-green-400" title={`Moved up ${delta} ranks vs yesterday`}>
        ↑ +{delta}
      </span>
    );
  }
  return (
    <span className="rounded border border-red-700/40 bg-red-900/20 px-1.5 py-0.5 text-[10px] font-bold text-red-400" title={`Moved down ${-delta} ranks vs yesterday`}>
      ↓ {delta}
    </span>
  );
}

function StockPickCard({ pick, rank, ruleBased, aiRationale, onOpenDrawer }) {
  const [expanded, setExpanded] = useState(false);

  const verdict   = ruleBased?.analysis?.verdict ?? aiRationale?.analysis?.verdict;
  const chips     = ruleBased?.analysis?.signal_chips ?? [];
  const changeCol = (pick.changePct ?? 0) >= 0 ? "text-green-400" : "text-red-400";

  // One-line "why" for Tier 1
  const parts = [];
  if (pick.signalCount)       parts.push(`${pick.signalCount} signal${pick.signalCount !== 1 ? "s" : ""}`);
  if ((pick.rsVsNifty3M ?? 0) >= 5) parts.push(`Outperforming Nifty +${pick.rsVsNifty3M?.toFixed(0)}pp 3M`);
  else if ((pick.rsVsNifty1M ?? 0) >= 5) parts.push(`Outperforming Nifty +${pick.rsVsNifty1M?.toFixed(0)}pp 1M`);
  const brief = parts.join(" · ");

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      {/* ── Tier 1 ─────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Name row */}
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-blue-400">#{rank}</span>
            {onOpenDrawer ? (
              <button
                onClick={() => onOpenDrawer({ type: "STOCK", id: pick.symbol?.replace(".NS", "") })}
                className="font-semibold leading-snug text-gray-100 hover:text-blue-400 hover:underline text-left"
              >
                {pick.label}
              </button>
            ) : (
              <span className="font-semibold leading-snug text-gray-100">{pick.label}</span>
            )}
            <span className="text-[10px] text-gray-600 font-mono">{pick.symbol?.replace(".NS", "")}</span>
          </div>
          {/* Tag row */}
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">
              {pick.sector}
            </span>
            {verdict && (
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${VERDICT_STYLE[verdict] ?? "bg-gray-700/30 text-gray-300 border-gray-600/40"}`}>
                {verdict}
              </span>
            )}
            {aiRationale && (
              <span className="rounded-full border border-purple-700/40 bg-purple-900/20 px-2 py-0.5 text-[10px] font-bold text-purple-400">
                ✦ AI
              </span>
            )}
            <StabilityChip pick={pick} />
            <RankDeltaChip delta={pick.rankDelta} />
          </div>
          {/* Price + brief summary */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {pick.close != null && (
              <span className="text-gray-400">
                ₹{pick.close.toLocaleString("en-IN")}
                {" "}
                <span className={changeCol}>
                  {pick.changePct >= 0 ? "+" : ""}{pick.changePct?.toFixed(2)}%
                </span>
              </span>
            )}
            {brief && <span className="text-gray-500">{brief}</span>}
          </div>
        </div>

        {/* Score + expand toggle */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <ScoreBadge score={pick.compositeScore} />
          <button
            onClick={() => setExpanded((e) => !e)}
            className="rounded-lg bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-400 transition hover:bg-gray-700 hover:text-gray-200"
          >
            {expanded ? "Hide ▲" : "Details ▾"}
          </button>
        </div>
      </div>

      {/* ── Tier 2: expanded detail ────────────────────────────── */}
      {expanded && (
        <div className="mt-3 space-y-3 border-t border-gray-800/60 pt-3">
          {/* Signal chips */}
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c, i) => (
                <span
                  key={i}
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${CHIP_STYLE[c.type] ?? "bg-gray-700/30 text-gray-300 border-gray-600/40"}`}
                >
                  {c.label}
                </span>
              ))}
            </div>
          )}

          {/* Fundamentals */}
          {pick.fundamentals && (
            <div className="grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-5">
              <Tech label="Market Cap"  val={pick.fundamentals.marketCapCr}     fmt={fmtMcap}                                        color="text-gray-200" />
              <Tech label="P/E"         val={pick.fundamentals.trailingPE}       fmt={(v) => v != null ? v.toFixed(0) : "—"}         color={pick.fundamentals.trailingPE > 50 ? "text-yellow-400" : pick.fundamentals.trailingPE < 15 ? "text-green-400" : "text-gray-200"} />
              <Tech label="EPS Growth"  val={pick.fundamentals.earningsGrowth}   fmt={(v) => v != null ? `${v >= 0 ? "+" : ""}${v}%` : "—"} color={(pick.fundamentals.earningsGrowth ?? 0) >= 20 ? "text-green-400" : (pick.fundamentals.earningsGrowth ?? 0) < 0 ? "text-red-400" : "text-gray-200"} />
              <Tech label="ROE"         val={pick.fundamentals.returnOnEquity}   fmt={(v) => v != null ? `${v}%` : "—"}             color={(pick.fundamentals.returnOnEquity ?? 0) >= 20 ? "text-green-400" : "text-gray-200"} />
              <Tech label="Div Yield"   val={pick.fundamentals.dividendYield}    fmt={(v) => v != null ? `${v}%` : "—"}             color="text-gray-200" />
            </div>
          )}

          {/* Technicals */}
          <div className="grid grid-cols-3 gap-2 text-[10px] sm:grid-cols-6">
            <Tech label="RSI(14)"       val={pick.rsi14}       fmt={(v) => v != null ? v.toFixed(0) : "—"}           color={pick.rsiSignal === "overbought" ? "text-red-400" : pick.rsiSignal === "oversold" ? "text-blue-400" : "text-gray-300"} />
            <Tech label="20 DMA"        val={pick.dma20}        fmt={(v) => v ? `₹${v.toFixed(0)}` : "—"}            color={pick.above20DMA ? "text-green-400" : "text-red-400"} />
            <Tech label="50 DMA"        val={pick.dma50}        fmt={(v) => v ? `₹${v.toFixed(0)}` : "—"}            color={pick.above50DMA ? "text-green-400" : "text-red-400"} />
            <Tech label="200 DMA"       val={pick.dma200}       fmt={(v) => v ? `₹${v.toFixed(0)}` : "—"}            color={pick.above200DMA ? "text-green-400" : "text-red-400"} />
            <Tech label="RS 1M vs Nifty" val={pick.rsVsNifty1M} fmt={(v) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp` : "—"} color={(pick.rsVsNifty1M ?? 0) >= 5 ? "text-lime-400" : (pick.rsVsNifty1M ?? 0) >= 0 ? "text-green-400" : "text-red-400"} />
            <Tech label="RS 3M vs Nifty" val={pick.rsVsNifty3M} fmt={(v) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp` : "—"} color={(pick.rsVsNifty3M ?? 0) >= 10 ? "text-lime-400" : (pick.rsVsNifty3M ?? 0) >= 0 ? "text-green-400" : "text-red-400"} />
          </div>

          {/* Rationale (Tier 3 nested collapses) */}
          <RationaleSection ruleBased={ruleBased} aiRationale={aiRationale} />
        </div>
      )}
    </div>
  );
}

// ─── Discovery widget (one feed tile) ────────────────────────────────────────

function DiscoveryWidget({ title, icon, color, items, renderItem, emptyMsg, staleNote }) {
  const [open, setOpen] = useState(false);
  if (!items?.length && !emptyMsg) return null;
  const visible = open ? items.slice(0, 50) : items.slice(0, 5);

  return (
    <div className={`overflow-hidden rounded-2xl border ${color} bg-gray-900`}>
      <div className="flex items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span>{icon}</span>
          <span className="text-sm font-semibold text-gray-200 truncate">{title}</span>
          <span className="rounded-full bg-gray-800 px-1.5 py-0.5 text-[10px] tabular-nums text-gray-500 shrink-0">
            {items?.length ?? 0}
          </span>
          {staleNote && (
            <span title={staleNote} className="shrink-0 rounded bg-yellow-900/30 px-1.5 py-0.5 text-[9px] font-bold text-yellow-400 border border-yellow-800/40">
              ⏳ {staleNote}
            </span>
          )}
        </div>
        {items?.length > 5 && (
          <button onClick={() => setOpen(!open)} className="text-[10px] text-blue-400 hover:text-blue-300 shrink-0 ml-2">
            {open ? "− show less" : `+ show all ${items.length}`}
          </button>
        )}
      </div>
      <div className="border-t border-gray-800/60">
        {items?.length === 0 && emptyMsg && (
          <div className="px-4 py-3 text-[11px] text-gray-600 italic">{emptyMsg}</div>
        )}
        {visible.map((item, i) => renderItem(item, i))}
      </div>
    </div>
  );
}

// ─── Discovery section (4-tile grid inside accordion) ────────────────────────

function DiscoverySection({ discovery, niftyReturns, scannedPicks }) {
  if (!discovery) return null;
  const { highs52w, topGainers, oiBuildup, bulkDeals, blockDeals } = discovery;
  const inst = [
    ...(blockDeals ?? []).map((d) => ({ ...d, kind: "BLOCK" })),
    ...(bulkDeals  ?? []).map((d) => ({ ...d, kind: "BULK" })),
  ].slice(0, 30);
  const pickMovers = (scannedPicks ?? [])
    .filter((p) => p.changePct != null)
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .slice(0, 20);

  return (
    <div className="space-y-3 px-3 pb-3">
      <p className="text-[10px] text-gray-600 px-1">
        Live feeds from NSE — independent of our universe scan.
        {niftyReturns && ` Nifty 1M: ${niftyReturns.ret1m >= 0 ? "+" : ""}${niftyReturns.ret1m?.toFixed(1)}% · 3M: ${niftyReturns.ret3m >= 0 ? "+" : ""}${niftyReturns.ret3m?.toFixed(1)}%`}
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <DiscoveryWidget
          title="52-Week Highs" icon="🚀" color="border-green-900/40" items={highs52w}
          renderItem={(d, i) => (
            <div key={i} className="flex items-center justify-between border-b border-gray-800/40 px-4 py-2 last:border-0">
              <div className="min-w-0">
                <div className="truncate text-xs text-gray-200">{d.company}</div>
                <div className="text-[10px] text-gray-600 font-mono">{d.symbol}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-xs font-semibold text-gray-200 tabular-nums">₹{d.ltp?.toLocaleString("en-IN")}</div>
                <div className={`text-[10px] tabular-nums ${(d.pChange ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {d.pChange >= 0 ? "+" : ""}{d.pChange?.toFixed(2)}%
                </div>
              </div>
            </div>
          )}
        />

        <DiscoveryWidget
          title="Today's Movers (scanned universe)" icon="📊" color="border-blue-900/40"
          items={pickMovers} emptyMsg="Day-change data unavailable for the scanned universe."
          renderItem={(d, i) => (
            <div key={i} className="flex items-center justify-between border-b border-gray-800/40 px-4 py-2 last:border-0">
              <div className="min-w-0">
                <div className="truncate text-xs text-gray-200">{d.label}</div>
                <div className="text-[10px] text-gray-600">{d.symbol?.replace(".NS", "")} · {d.sector}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className={`text-xs font-bold tabular-nums ${(d.changePct ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {d.changePct >= 0 ? "+" : ""}{d.changePct?.toFixed(2)}%
                </div>
                <div className="text-[10px] text-gray-600 tabular-nums">₹{d.close?.toLocaleString("en-IN")}</div>
              </div>
            </div>
          )}
        />

        <DiscoveryWidget
          title="Today's Top Gainers (NSE, ≥₹20)" icon="⚡" color="border-yellow-900/40"
          items={topGainers}
          staleNote={discovery.staleFeeds?.includes("topGainers") ? "as of last trading day" : null}
          emptyMsg="Top gainers populate during market hours (NSE updates intraday)."
          renderItem={(d, i) => (
            <div key={i} className="flex items-center justify-between border-b border-gray-800/40 px-4 py-2 last:border-0">
              <div className="min-w-0">
                <div className="text-xs text-gray-200 font-mono">{d.symbol}</div>
                <div className="text-[10px] text-gray-600">₹{d.ltp?.toLocaleString("en-IN")}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-xs font-bold text-green-400 tabular-nums">
                  +{(d.pChange ?? 0).toFixed(2)}%
                </div>
                {d.turnover != null && (
                  <div className="text-[10px] text-gray-600 tabular-nums">₹{(d.turnover / 100).toFixed(1)}Cr</div>
                )}
              </div>
            </div>
          )}
        />

        <DiscoveryWidget
          title="Institutional Trades (Bulk + Block)" icon="💼" color="border-fuchsia-900/40"
          items={inst}
          staleNote={
            discovery.staleFeeds?.includes("bulkDeals") || discovery.staleFeeds?.includes("blockDeals")
              ? (inst[0]?.date ? `as of ${inst[0].date}` : "stale")
              : null
          }
          emptyMsg="No bulk/block deals available yet. NSE publishes these EOD on trading days."
          renderItem={(d, i) => (
            <div key={i} className="flex items-center justify-between border-b border-gray-800/40 px-4 py-2 last:border-0">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-200 font-mono">{d.symbol}</span>
                  <span className={`rounded px-1 py-0 text-[8px] font-bold ${d.kind === "BLOCK" ? "bg-fuchsia-900/50 text-fuchsia-300" : "bg-pink-900/40 text-pink-300"}`}>{d.kind}</span>
                  <span className={`rounded px-1 py-0 text-[8px] font-bold ${d.bs === "BUY" ? "bg-green-900/40 text-green-300" : "bg-red-900/40 text-red-300"}`}>{d.bs}</span>
                </div>
                <div className="truncate text-[10px] text-gray-600">{d.client}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-xs text-gray-300 tabular-nums">{(d.qty / 1e5).toFixed(1)}L @ ₹{d.price?.toFixed(0)}</div>
                <div className="text-[10px] text-gray-600 tabular-nums">{d.date}</div>
              </div>
            </div>
          )}
        />

        <DiscoveryWidget
          title="F&O OI Buildup (Long + Short Cover)" icon="📈" color="border-indigo-900/40"
          items={[
            ...(oiBuildup?.longBuildup   ?? []).map((d) => ({ ...d, kind: "LONG" })),
            ...(oiBuildup?.shortCovering ?? []).map((d) => ({ ...d, kind: "S.COVER" })),
          ]}
          staleNote={discovery.staleFeeds?.includes("oiBuildup") ? "intraday-only · last trading day" : null}
          emptyMsg="F&O OI buildup is intraday-only — NSE publishes during market hours (Mon-Fri, 9:15–15:30 IST)."
          renderItem={(d, i) => (
            <div key={i} className="flex items-center justify-between border-b border-gray-800/40 px-4 py-2 last:border-0">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-200 font-mono">{d.symbol}</span>
                  <span className={`rounded px-1 py-0 text-[8px] font-bold ${d.kind === "LONG" ? "bg-emerald-900/50 text-emerald-300" : "bg-cyan-900/40 text-cyan-300"}`}>{d.kind}</span>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className={`text-xs font-semibold tabular-nums ${(d.pChange ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {d.pChange >= 0 ? "+" : ""}{d.pChange?.toFixed(2)}%
                </div>
                <div className="text-[10px] text-gray-600 tabular-nums">OI Δ {d.oiChangePct >= 0 ? "+" : ""}{d.oiChangePct?.toFixed(1)}%</div>
              </div>
            </div>
          )}
        />
      </div>
    </div>
  );
}

// ─── Phase 4: Discovery accordion ────────────────────────────────────────────
//
// Collapsed by default so picks appear immediately under the page header.
// Counting "active" feeds (those with at least one item).

function DiscoveryAccordion({ discovery, niftyReturns, scannedPicks }) {
  const [open, setOpen] = useState(false);
  if (!discovery) return null;

  const { highs52w, topGainers, oiBuildup, bulkDeals, blockDeals } = discovery;
  const feeds = [highs52w, topGainers, ...(oiBuildup ? [oiBuildup.longBuildup, oiBuildup.shortCovering] : []), bulkDeals, blockDeals];
  const activeCount = feeds.filter((f) => Array.isArray(f) ? f.length > 0 : false).length;

  return (
    <div className="overflow-hidden rounded-2xl border border-purple-800/40 bg-gray-950">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span>🔭</span>
          <span className="text-sm font-semibold text-purple-200">NSE Discovery Feeds</span>
          <span className="rounded-full bg-purple-900/30 border border-purple-800/40 px-2 py-0.5 text-[10px] font-semibold text-purple-400">
            {activeCount} active
          </span>
        </div>
        <span className="text-gray-500 text-sm">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-gray-800/60">
          <DiscoverySection
            discovery={discovery}
            niftyReturns={niftyReturns}
            scannedPicks={scannedPicks}
          />
        </div>
      )}
    </div>
  );
}

// ─── Shared UI helpers ────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      <p className="animate-pulse text-center text-sm text-gray-400">Loading…</p>
    </div>
  );
}

function ErrorBox({ msg }) {
  return (
    <div className="rounded-2xl border border-red-800/40 bg-red-900/20 px-5 py-4 text-sm text-red-300">
      <strong>Error:</strong> {msg}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StockPicks() {
  const { user } = useAuth();
  const { data: stockPicksData, builtAt, loading: dataLoading, error: dataError } = useOutletContext();

  const [stockRuleRat, setStockRuleRat] = useState({});
  const [stockAiRat,   setStockAiRat]   = useState({});
  const [stockShowCount, setStockShowCount] = useState(10);
  const [drawer,       setDrawer]       = useState(null);
  const [filterMode,   setFilterMode]   = useState("core"); // "core" | "tactical" | "all"

  useEffect(() => {
    Promise.all([
      supabase.from("stock_pick_rationales").select("*").order("run_date", { ascending: false }).order("rank").limit(50),
      supabase.from("stock_pick_ai_rationales").select("*").order("rank"),
    ]).then(([sRule, sAi]) => {
      if (!sRule.error && sRule.data) {
        const bySymbol = {};
        sRule.data.forEach((r) => { if (!bySymbol[r.symbol]) bySymbol[r.symbol] = r; });
        setStockRuleRat(bySymbol);
      }
      if (!sAi.error && sAi.data) {
        const bySymbol = {};
        sAi.data.forEach((r) => { bySymbol[r.symbol] = r; });
        setStockAiRat(bySymbol);
      }
    });
  }, []);

  if (dataLoading) return <Spinner />;
  if (dataError)   return <ErrorBox msg={dataError} />;
  if (!stockPicksData) return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
      Stock picks not computed yet — run the signals refresh job first.
    </div>
  );

  const signalsPicks = stockPicksData?.picks ?? [];
  const intradayAsOf = stockPicksData?.intradayAsOf;

  // ── Stability filtering ──────────────────────────────────────────────────
  // Core    = held top 50 for 7+ days (stable enough to act on)
  // Tactical = new/recent entries (< 7 days) — watch, not buy
  // All     = everything
  // Pipeline still shows top 50 ranked by score within each subset.
  const corePicks     = signalsPicks.filter((p) => (p.daysInTop50 ?? 0) >= 7);
  const tacticalPicks = signalsPicks.filter((p) => (p.daysInTop50 ?? 0) < 7);
  const filteredPicks = filterMode === "core"     ? corePicks
                      : filterMode === "tactical" ? tacticalPicks
                      : signalsPicks;
  // If persistence data isn't built yet (first deploy or pre-stability run),
  // gracefully fall back to all picks regardless of filter.
  const hasPersistenceData = signalsPicks.some((p) => p.daysInTop50 != null);
  const displayedPicks = hasPersistenceData ? filteredPicks : signalsPicks;
  const isIntraday = intradayAsOf && (Date.now() - new Date(intradayAsOf)) < 2 * 60 * 60 * 1000; // within 2h

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold">Stock Top Picks</h1>
            {isIntraday && (
              <span className="inline-flex items-center gap-1 text-xs bg-green-500/15 text-green-400 border border-green-600/30 rounded px-2 py-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                Live · {timeAgo(intradayAsOf)}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-gray-500">
            {signalsPicks.length} ranked picks · scanned {stockPicksData?.scanned ?? 0} of {stockPicksData?.universe ?? 0} Nifty 500 names
            {" · "}{Object.values(stockRuleRat).length} rationales seeded
            {builtAt && <> · updated {timeAgo(builtAt)}</>}
          </p>
        </div>
        <Link
          to="/glossary"
          className="mt-1 shrink-0 text-[10px] text-gray-600 hover:text-blue-400 transition"
        >
          What do these terms mean? →
        </Link>
      </div>

      {/* Phase 4: Discovery accordion — collapsed by default */}
      <DiscoveryAccordion
        discovery={stockPicksData?.discovery}
        niftyReturns={stockPicksData?.niftyReturns}
        scannedPicks={stockPicksData?.all ?? signalsPicks}
      />

      {/* Stability filter tabs */}
      {hasPersistenceData && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">View:</span>
            <FilterTab
              active={filterMode === "core"}
              onClick={() => setFilterMode("core")}
              activeCls="bg-emerald-600 text-white border-emerald-500"
              icon="📌"
              label="Core"
              count={corePicks.length}
              hint="stable for 7+ days"
            />
            <FilterTab
              active={filterMode === "tactical"}
              onClick={() => setFilterMode("tactical")}
              activeCls="bg-amber-600 text-white border-amber-500"
              icon="⚡"
              label="Tactical"
              count={tacticalPicks.length}
              hint="recent entries"
            />
            <FilterTab
              active={filterMode === "all"}
              onClick={() => setFilterMode("all")}
              activeCls="bg-blue-600 text-white border-blue-500"
              icon="📊"
              label="All"
              count={signalsPicks.length}
            />
            <p className="ml-auto hidden md:block text-[10px] text-gray-500">
              {filterMode === "core" && "Held the top 50 for 7+ trading days — stable enough to act on."}
              {filterMode === "tactical" && "Recent entries (< 7 days). Treat as watchlist, not buy list."}
              {filterMode === "all" && "Every pick in today's top 50 — sorted by composite score."}
            </p>
          </div>
        </div>
      )}

      {/* Pick cards */}
      <div className="space-y-3">
        {displayedPicks.slice(0, stockShowCount).map((pick) => (
          <StockPickCard
            key={pick.symbol}
            pick={pick}
            rank={pick.rank ?? "—"}
            ruleBased={stockRuleRat[pick.symbol] ?? null}
            aiRationale={stockAiRat[pick.symbol] ?? null}
            onOpenDrawer={setDrawer}
          />
        ))}

        {displayedPicks.length === 0 && hasPersistenceData && (
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
            {filterMode === "core" && "No Core picks yet — persistence tracking just started. Check back in a week."}
            {filterMode === "tactical" && "No Tactical picks right now — all current picks have been stable for 7+ days."}
          </div>
        )}

        {signalsPicks.length === 0 && (
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
            No signal-based picks computed yet.
          </div>
        )}
      </div>

      {/* Show more / show less */}
      {displayedPicks.length > 10 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          {stockShowCount < displayedPicks.length && (
            <>
              <button
                onClick={() => {
                  const next = Math.min(stockShowCount + 10, displayedPicks.length);
                  setStockShowCount(next);
                  trackEvent(user, `show_more:${next}`, "/stocks/picks");
                }}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                Show 10 more ({displayedPicks.length - stockShowCount} remaining)
              </button>
              <button
                onClick={() => {
                  setStockShowCount(displayedPicks.length);
                  trackEvent(user, "show_all", "/stocks/picks");
                }}
                className="rounded-xl bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700"
              >
                Show all {displayedPicks.length}
              </button>
            </>
          )}
          {stockShowCount > 10 && (
            <button
              onClick={() => {
                setStockShowCount(10);
                trackEvent(user, "show_top_10", "/stocks/picks");
                document.documentElement.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className="rounded-xl bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700"
            >
              Collapse to top 10
            </button>
          )}
        </div>
      )}

      <PageFooter sections={[
        {
          title: "Data Sources",
          items: [
            '<span class="text-gray-400">NSE via Yahoo Finance</span> — daily OHLCV price data (end-of-day)',
            '<span class="text-gray-400">NSE bhavcopy</span> — delivery %, bulk &amp; block institutional trades',
            '<span class="text-gray-400">NSE F&amp;O feeds</span> — open interest buildup &amp; short-covering',
            "GitHub Actions refreshes stock data at 4 PM IST daily (after NSE close)",
          ],
        },
        {
          title: "Composite Score (0–100)",
          items: [
            "15+ signals scored daily: breakouts, volume, momentum, trend, patterns",
            "Relative Strength vs Nifty 50 (1M &amp; 3M excess return)",
            "Fundamentals: large-cap +3, earnings growth ≥20% +5, RoE ≥20% +3",
            '<span class="text-yellow-300">Two-layer scoring</span> — EOD signals (3:45 PM) + intraday signals refreshed live (5× daily, 9:30 AM–3:30 PM IST)',
            "Low volatility · a stock needs sustained signals across days to rank",
          ],
        },
        {
          title: "Signal Key",
          items: [
            '<span class="text-green-400">RS 1M/3M</span> — stock return minus Nifty (positive = outperforming index)',
            '<span class="text-amber-400">RSI</span> — oversold (≤30) adds +6 pts; overbought (≥70) subtracts −4 pts',
            '<span class="text-blue-400">Golden Cross</span> — 50d MA crossed above 200d MA within last 5 sessions (+18)',
            '<span class="text-purple-400">Volume Shock</span> — today\'s volume ≥ 2× 20-day avg (+16 to +28)',
            '<span class="text-orange-400">Block/Bulk Buy</span> — institutional block deal +18, bulk deal +12',
            '<span class="text-pink-400">52W High</span> — at or within 2% of 52-week high (+18 to +22)',
          ],
        },
      ]} />

      <InstrumentDrawer
        open={drawer != null}
        type={drawer?.type}
        id={drawer?.id}
        onClose={() => setDrawer(null)}
      />
    </div>
  );
}
