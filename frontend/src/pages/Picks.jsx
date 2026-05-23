import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";
import { trackEvent } from "../lib/analytics";

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

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

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

function RationaleSection({ ruleBased, aiRationale }) {
  const [openRule, setOpenRule] = useState(false);
  const [openAi,   setOpenAi]   = useState(false);
  if (!ruleBased && !aiRationale) return null;

  return (
    <div className="mt-3 space-y-2">
      {/* Rule-based panel */}
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

      {/* AI panel */}
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

const WINDOWS     = ["1W", "1M", "3M", "6M", "1Y"];
const WINDOW_KEYS = ["ret1w", "ret1m", "ret3m", "ret6m", "ret1y"];

function fmt(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function zLabel(z) {
  if (z == null) return null;
  if (z >= 1.5)  return { text: "🔥 Hot",     bg: "bg-orange-500/20 text-orange-300 border-orange-600/40" };
  if (z >= 0.5)  return { text: "↑ Warm",    bg: "bg-yellow-500/20 text-yellow-300 border-yellow-600/40" };
  if (z >= -0.5) return { text: "→ Neutral",  bg: "bg-gray-600/30  text-gray-400   border-gray-600/40"   };
  if (z >= -1.5) return { text: "↓ Cool",    bg: "bg-blue-500/20  text-blue-300   border-blue-600/40"   };
  return                 { text: "❄ Cold",    bg: "bg-indigo-500/20 text-indigo-300 border-indigo-600/40" };
}

function RetVal({ val, bold }) {
  const color = (val ?? 0) >= 0 ? "text-green-400" : "text-red-400";
  return (
    <span className={`tabular-nums ${color} ${bold ? "font-bold" : "font-medium"}`}>
      {fmt(val)}
    </span>
  );
}

function score(fund, catZ) {
  return (fund.ret1w ?? 0) * 0.4
       + (fund.ret1m ?? 0) * 0.3
       + (fund.ret3m ?? 0) * 0.2
       + (catZ       ?? 0) * 5 * 0.1;
}

function buildMfPicks(mfData) {
  return mfData.categories
    .map((cat) => {
      const catZ = cat.median.z1w ?? 0;
      const top  = [...cat.funds]
        .map((f) => ({ ...f, score: score(f, catZ), catZ, category: cat.category }))
        .sort((a, b) => b.score - a.score)[0];
      return top ?? null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function buildStockPicks(stockData) {
  return stockData.sectors
    .filter((s) => (s.median.z1w ?? 0) >= 0.5)
    .sort((a, b) => (b.median.z1w ?? 0) - (a.median.z1w ?? 0))
    .map((sec) => ({
      sector:      sec.sector,
      sectorZ:     sec.median.z1w,
      sectorMedian: sec.median,
      top:         sec.stocks.slice(0, 3),
    }));
}

// ─── Stock signals (new) ──────────────────────────────────────────────────────

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

function fmtMcap(cr) {
  if (cr == null) return null;
  if (cr >= 1e5) return `₹${(cr / 1e5).toFixed(2)}L Cr`;
  return `₹${cr.toLocaleString("en-IN")} Cr`;
}

function ScoreBadge({ score }) {
  const color = score >= 60 ? "from-green-700 to-green-500"
              : score >= 40 ? "from-yellow-700 to-yellow-500"
              : score >= 25 ? "from-blue-700 to-blue-500"
              :               "from-gray-700 to-gray-600";
  return (
    <div className="flex shrink-0 flex-col items-end">
      <div className={`rounded-lg bg-gradient-to-br ${color} px-2.5 py-1 text-center min-w-[58px]`}>
        <div className="text-base font-bold text-white tabular-nums leading-none">{score}</div>
        <div className="text-[8px] text-white/70 uppercase tracking-wider">score</div>
      </div>
    </div>
  );
}

function StockPickCard({ pick, rank, ruleBased, aiRationale }) {
  const verdict   = ruleBased?.analysis?.verdict ?? aiRationale?.analysis?.verdict;
  const chips     = ruleBased?.analysis?.signal_chips ?? [];
  const changeCol = (pick.changePct ?? 0) >= 0 ? "text-green-400" : "text-red-400";

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      {/* header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-blue-400">#{rank}</span>
            <span className="font-semibold leading-snug text-gray-100">{pick.label}</span>
            <span className="text-[10px] text-gray-600 font-mono">{pick.symbol?.replace(".NS","")}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
        </div>

        <div className="flex shrink-0 items-start gap-2">
          {pick.close != null && (
            <div className="text-right">
              <div className="text-xs text-gray-500">Price</div>
              <div className="text-sm font-semibold text-gray-200 tabular-nums">
                ₹{pick.close.toLocaleString("en-IN")}
              </div>
              <div className={`text-[10px] tabular-nums ${changeCol}`}>
                {pick.changePct >= 0 ? "+" : ""}{pick.changePct?.toFixed(2)}%
              </div>
            </div>
          )}
          <ScoreBadge score={pick.compositeScore} />
        </div>
      </div>

      {/* signal chips */}
      {chips.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {chips.map((c, i) => (
            <span key={i} className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${CHIP_STYLE[c.type] ?? "bg-gray-700/30 text-gray-300 border-gray-600/40"}`}>
              {c.label}
            </span>
          ))}
        </div>
      )}

      {/* Fundamentals strip (only when available) */}
      {pick.fundamentals && (
        <div className="mb-3 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-5">
          <Tech label="Market Cap"  val={pick.fundamentals.marketCapCr} fmt={fmtMcap} color="text-gray-200" />
          <Tech label="P/E"         val={pick.fundamentals.trailingPE}  fmt={(v) => v != null ? v.toFixed(0) : "—"}
                color={pick.fundamentals.trailingPE > 50 ? "text-yellow-400" : pick.fundamentals.trailingPE < 15 ? "text-green-400" : "text-gray-200"} />
          <Tech label="EPS Growth"  val={pick.fundamentals.earningsGrowth} fmt={(v) => v != null ? `${v >= 0 ? "+" : ""}${v}%` : "—"}
                color={(pick.fundamentals.earningsGrowth ?? 0) >= 20 ? "text-green-400" : (pick.fundamentals.earningsGrowth ?? 0) < 0 ? "text-red-400" : "text-gray-200"} />
          <Tech label="ROE"         val={pick.fundamentals.returnOnEquity} fmt={(v) => v != null ? `${v}%` : "—"}
                color={(pick.fundamentals.returnOnEquity ?? 0) >= 20 ? "text-green-400" : "text-gray-200"} />
          <Tech label="Div Yield"   val={pick.fundamentals.dividendYield} fmt={(v) => v != null ? `${v}%` : "—"}
                color="text-gray-200" />
        </div>
      )}

      {/* Technicals + Relative Strength */}
      <div className="grid grid-cols-3 gap-2 text-[10px] sm:grid-cols-6">
        <Tech label="RSI(14)" val={pick.rsi14} fmt={(v) => v != null ? v.toFixed(0) : "—"}
              color={pick.rsiSignal === "overbought" ? "text-red-400" : pick.rsiSignal === "oversold" ? "text-blue-400" : "text-gray-300"} />
        <Tech label="20 DMA"  val={pick.dma20}  fmt={(v) => v ? `₹${v.toFixed(0)}` : "—"}
              color={pick.above20DMA ? "text-green-400" : "text-red-400"} />
        <Tech label="50 DMA"  val={pick.dma50}  fmt={(v) => v ? `₹${v.toFixed(0)}` : "—"}
              color={pick.above50DMA ? "text-green-400" : "text-red-400"} />
        <Tech label="200 DMA" val={pick.dma200} fmt={(v) => v ? `₹${v.toFixed(0)}` : "—"}
              color={pick.above200DMA ? "text-green-400" : "text-red-400"} />
        <Tech label="RS 1M vs Nifty" val={pick.rsVsNifty1M}
              fmt={(v) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp` : "—"}
              color={(pick.rsVsNifty1M ?? 0) >= 5 ? "text-lime-400" : (pick.rsVsNifty1M ?? 0) >= 0 ? "text-green-400" : "text-red-400"} />
        <Tech label="RS 3M vs Nifty" val={pick.rsVsNifty3M}
              fmt={(v) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp` : "—"}
              color={(pick.rsVsNifty3M ?? 0) >= 10 ? "text-lime-400" : (pick.rsVsNifty3M ?? 0) >= 0 ? "text-green-400" : "text-red-400"} />
      </div>

      <RationaleSection ruleBased={ruleBased} aiRationale={aiRationale} />
    </div>
  );
}

function Tech({ label, val, fmt, color }) {
  return (
    <div className="rounded-lg bg-gray-800/40 px-2 py-1.5">
      <div className="text-[9px] text-gray-600 uppercase tracking-wider">{label}</div>
      <div className={`text-xs font-semibold tabular-nums ${color}`}>{fmt(val)}</div>
    </div>
  );
}

// ─── Discovery section (NSE feeds) ──────────────────────────────────────────

function DiscoveryWidget({ title, icon, color, items, renderItem, emptyMsg }) {
  const [open, setOpen] = useState(false);
  if (!items?.length && !emptyMsg) return null;
  const visible = open ? items.slice(0, 50) : items.slice(0, 5);

  return (
    <div className={`overflow-hidden rounded-2xl border ${color} bg-gray-900`}>
      <div className="flex items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span>{icon}</span>
          <span className="text-sm font-semibold text-gray-200">{title}</span>
          <span className="rounded-full bg-gray-800 px-1.5 py-0.5 text-[10px] tabular-nums text-gray-500">{items?.length ?? 0}</span>
        </div>
        {items?.length > 5 && (
          <button onClick={() => setOpen(!open)} className="text-[10px] text-blue-400 hover:text-blue-300">
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

function DiscoverySection({ discovery, niftyReturns, builtAt }) {
  if (!discovery) return null;
  const { highs52w, topGainers, oiBuildup, bulkDeals, blockDeals } = discovery;
  // Combine block + bulk as "institutional"
  const inst = [
    ...(blockDeals ?? []).map((d) => ({ ...d, kind: "BLOCK" })),
    ...(bulkDeals  ?? []).map((d) => ({ ...d, kind: "BULK" })),
  ].slice(0, 30);

  return (
    <div className="space-y-3 rounded-2xl border border-purple-800/40 bg-gray-950 p-3">
      <div className="flex items-center justify-between px-1">
        <div>
          <div className="text-sm font-semibold text-purple-200">🔭 NSE Discovery</div>
          <p className="mt-0.5 text-[10px] text-gray-600">
            Live feeds from NSE — independent of our universe scan. {niftyReturns && `Nifty 1M: ${niftyReturns.ret1m >= 0 ? "+" : ""}${niftyReturns.ret1m?.toFixed(1)}% · 3M: ${niftyReturns.ret3m >= 0 ? "+" : ""}${niftyReturns.ret3m?.toFixed(1)}%`}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <DiscoveryWidget
          title="52-Week Highs"
          icon="🚀"
          color="border-green-900/40"
          items={highs52w}
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
          title="Top Gainers"
          icon="⚡"
          color="border-yellow-900/40"
          items={topGainers}
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
          title="Institutional Trades (Bulk + Block)"
          icon="💼"
          color="border-fuchsia-900/40"
          items={inst}
          emptyMsg="No bulk/block deals fetched (NSE rate-limited or weekend)"
          renderItem={(d, i) => (
            <div key={i} className="flex items-center justify-between border-b border-gray-800/40 px-4 py-2 last:border-0">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-200 font-mono">{d.symbol}</span>
                  <span className={`rounded px-1 py-0 text-[8px] font-bold ${d.kind === "BLOCK" ? "bg-fuchsia-900/50 text-fuchsia-300" : "bg-pink-900/40 text-pink-300"}`}>
                    {d.kind}
                  </span>
                  <span className={`rounded px-1 py-0 text-[8px] font-bold ${d.bs === "BUY" ? "bg-green-900/40 text-green-300" : "bg-red-900/40 text-red-300"}`}>
                    {d.bs}
                  </span>
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
          title="F&O OI Buildup (Long + Short Cover)"
          icon="📈"
          color="border-indigo-900/40"
          items={[
            ...(oiBuildup?.longBuildup    ?? []).map((d) => ({ ...d, kind: "LONG" })),
            ...(oiBuildup?.shortCovering  ?? []).map((d) => ({ ...d, kind: "S.COVER" })),
          ]}
          emptyMsg="No F&O OI data (market closed or weekend)"
          renderItem={(d, i) => (
            <div key={i} className="flex items-center justify-between border-b border-gray-800/40 px-4 py-2 last:border-0">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-200 font-mono">{d.symbol}</span>
                  <span className={`rounded px-1 py-0 text-[8px] font-bold ${d.kind === "LONG" ? "bg-emerald-900/50 text-emerald-300" : "bg-cyan-900/40 text-cyan-300"}`}>
                    {d.kind}
                  </span>
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

function MfPickCard({ fund, rank, ruleBased, aiRationale }) {
  const zl      = zLabel(fund.catZ);
  const verdict = ruleBased?.analysis?.verdict ?? aiRationale?.analysis?.verdict;

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-blue-400">#{rank}</span>
            <span className="font-semibold leading-snug text-gray-100">{fund.label}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">
              {fund.category}
            </span>
            {zl && (
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${zl.bg}`}>
                {zl.text}
              </span>
            )}
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
          </div>
        </div>
        {fund.latestNav && (
          <div className="shrink-0 text-right">
            <div className="text-xs text-gray-500">NAV</div>
            <div className="text-sm font-semibold text-gray-200">₹{fund.latestNav.toFixed(2)}</div>
          </div>
        )}
      </div>

      <div className="flex gap-3 overflow-x-auto pb-0.5">
        {WINDOWS.map((w, i) => (
          <div key={w} className="min-w-[36px] shrink-0 text-center">
            <div className="mb-0.5 text-[10px] text-gray-600">{w}</div>
            <RetVal val={fund[WINDOW_KEYS[i]]} bold={i === 0} />
          </div>
        ))}
      </div>

      <RationaleSection ruleBased={ruleBased} aiRationale={aiRationale} />
    </div>
  );
}

function StockPickGroup({ group }) {
  const zl = zLabel(group.sectorZ);
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <div className="flex items-center gap-2">
          {zl && (
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${zl.bg}`}>
              {zl.text}
            </span>
          )}
          <span className="font-semibold text-gray-100">{group.sector}</span>
        </div>
        <div className="flex shrink-0 gap-3">
          <div className="text-right">
            <div className="text-[10px] text-gray-600">1W</div>
            <RetVal val={group.sectorMedian.ret1w} />
          </div>
          <div className="text-right">
            <div className="text-[10px] text-gray-600">1M</div>
            <RetVal val={group.sectorMedian.ret1m} />
          </div>
        </div>
      </div>
      <div className="divide-y divide-gray-800/50">
        {group.top.map((stock) => (
          <div key={stock.symbol} className="px-4 py-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div>
                <span className="text-sm font-medium text-gray-200">{stock.label}</span>
                <span className="ml-2 text-xs text-gray-600">{stock.symbol.replace(".NS", "")}</span>
              </div>
              {stock.price && (
                <span className="tabular-nums text-xs text-gray-400">
                  ₹{stock.price.toLocaleString("en-IN")}
                </span>
              )}
            </div>
            <div className="flex gap-3 overflow-x-auto">
              {WINDOWS.map((w, i) => (
                <div key={w} className="min-w-[36px] shrink-0 text-center">
                  <div className="text-[10px] text-gray-600">{w}</div>
                  <RetVal val={stock[WINDOW_KEYS[i]]} bold={i === 0} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Picks() {
  const { user } = useAuth();
  const [mfData,           setMfData]           = useState(null);
  const [stockPicksData,   setStockPicksData]   = useState(null); // new: from `stock_picks` cache key
  const [stockData,        setStockData]        = useState(null); // legacy sector view (fallback)
  const [builtAt,          setBuiltAt]          = useState(null);
  const [stockBuiltAt,     setStockBuiltAt]     = useState(null);
  const [ruleRationale,    setRuleRationale]    = useState({});
  const [aiRationale,      setAiRationale]      = useState({});
  const [stockRuleRat,     setStockRuleRat]     = useState({});
  const [stockAiRat,       setStockAiRat]       = useState({});
  const [loading,          setLoading]          = useState(true);
  const [error,            setError]            = useState(null);
  const [tab,              setTab]              = useState("mf");

  function switchTab(key) {
    setTab(key);
    trackEvent(user, `tab:${key}`, "/picks");
  }

  useEffect(() => {
    Promise.all([
      supabase.from("radar_cache").select("data,built_at").eq("key", "mf_radar").single(),
      supabase.from("radar_cache").select("data,built_at").eq("key", "stock_radar").single(),
      supabase.from("radar_cache").select("data,built_at").eq("key", "stock_picks").maybeSingle(),
      supabase.from("pick_rationales").select("*").order("run_date", { ascending: false }).order("rank").limit(10),
      supabase.from("pick_ai_rationales").select("*").order("rank"),
      supabase.from("stock_pick_rationales").select("*").order("run_date", { ascending: false }).order("rank").limit(10),
      supabase.from("stock_pick_ai_rationales").select("*").order("rank"),
    ]).then(([mf, st, sp, rule, ai, sRule, sAi]) => {
      if (mf.error) { setError(mf.error.message); return; }
      if (st.error) { setError(st.error.message); return; }
      setMfData(mf.data.data);
      setStockData(st.data.data);
      setBuiltAt(mf.data.built_at);
      if (sp?.data) {
        setStockPicksData(sp.data.data);
        setStockBuiltAt(sp.data.built_at);
      }
      if (!rule.error && rule.data) {
        const byCode = {};
        rule.data.forEach((r) => { if (!byCode[r.fund_code]) byCode[r.fund_code] = r; });
        setRuleRationale(byCode);
      }
      if (!ai.error && ai.data) {
        const byCode = {};
        ai.data.forEach((r) => { byCode[r.fund_code] = r; });
        setAiRationale(byCode);
      }
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
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;
  if (error)   return <ErrorBox msg={error} />;
  if (!mfData) return <ErrorBox msg="No data yet — the first GitHub Actions run hasn't completed." />;

  const mfPicks       = buildMfPicks(mfData);
  const signalsPicks  = stockPicksData?.picks ?? [];
  const sectorGroups  = stockData ? buildStockPicks(stockData) : [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Picks</h1>
        <p className="mt-0.5 text-xs text-gray-500">
          Best per category · updated {builtAt ? timeAgo(builtAt) : "—"}
        </p>
      </div>

      <div className="flex gap-1 rounded-xl bg-gray-900 p-1">
        {[
          { key: "mf",     label: `📊 MF (${mfPicks.length})` },
          { key: "stocks", label: `📈 Stocks (${signalsPicks.length || sectorGroups.length})` },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => switchTab(t.key)}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
              tab === t.key ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "mf" && (
        <div className="space-y-3">
          <p className="text-xs text-gray-600">
            One fund per category · ranked by weighted momentum (40% 1W · 30% 1M · 20% 3M · 10% z-score)
          </p>
          {mfPicks.map((fund, i) => (
            <MfPickCard
              key={fund.code}
              fund={fund}
              rank={i + 1}
              ruleBased={ruleRationale[fund.code] ?? null}
              aiRationale={aiRationale[fund.code] ?? null}
            />
          ))}
        </div>
      )}

      {tab === "stocks" && (
        <div className="space-y-3">
          {signalsPicks.length > 0 ? (
            <>
              <p className="text-xs text-gray-600">
                Top {Math.min(10, signalsPicks.length)} of {stockPicksData?.picks?.length ?? 0} stocks ranked by composite momentum score · scanned{" "}
                {stockPicksData?.scanned ?? 0} of {stockPicksData?.universe ?? 0} Nifty 500 names · {Object.values(stockRuleRat).length} rationales seeded
                {stockBuiltAt && <> · updated {timeAgo(stockBuiltAt)}</>}
              </p>

              <DiscoverySection
                discovery={stockPicksData?.discovery}
                niftyReturns={stockPicksData?.niftyReturns}
                builtAt={stockBuiltAt}
              />

              {signalsPicks.slice(0, 10).map((pick, i) => (
                <StockPickCard
                  key={pick.symbol}
                  pick={pick}
                  rank={i + 1}
                  ruleBased={stockRuleRat[pick.symbol] ?? null}
                  aiRationale={stockAiRat[pick.symbol] ?? null}
                />
              ))}
            </>
          ) : (
            <>
              <p className="text-xs text-gray-600">
                Signal-based picks not yet computed. Showing sector momentum view.
              </p>
              {sectorGroups.length === 0 && (
                <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
                  No sectors in positive momentum right now.
                </div>
              )}
              {sectorGroups.map((g) => (
                <StockPickGroup key={g.sector} group={g} />
              ))}
            </>
          )}
        </div>
      )}

      <p className="pt-2 text-[10px] text-gray-700">
        Momentum signals only — not financial advice. Past performance does not guarantee future returns.
      </p>
    </div>
  );
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

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
