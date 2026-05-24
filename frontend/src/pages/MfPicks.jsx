import { useEffect, useState } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";

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

const RETURN_WINDOWS = [
  { label: "1W",       key: "ret1w"   },
  { label: "1M",       key: "ret1m"   },
  { label: "3M",       key: "ret3m"   },
  { label: "6M",       key: "ret6m"   },
  { label: "1Y",       key: "ret1y"   },
  { label: "5Y CAGR",  key: "cagr5y"  },
  { label: "10Y CAGR", key: "cagr10y" },
];

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmt(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function zLabel(z) {
  if (z == null) return null;
  if (z >= 1.5)  return { text: "🔥 Hot",    bg: "bg-orange-500/20 text-orange-300 border-orange-600/40" };
  if (z >= 0.5)  return { text: "↑ Warm",   bg: "bg-yellow-500/20 text-yellow-300 border-yellow-600/40" };
  if (z >= -0.5) return { text: "→ Neutral", bg: "bg-gray-600/30  text-gray-400   border-gray-600/40"   };
  if (z >= -1.5) return { text: "↓ Cool",   bg: "bg-blue-500/20  text-blue-300   border-blue-600/40"   };
  return                 { text: "❄ Cold",   bg: "bg-indigo-500/20 text-indigo-300 border-indigo-600/40" };
}

// Resolve verdict + confidence from either rationale store (rule-based takes precedence)
function resolveAnalysis(code, ruleMap, aiMap) {
  const src = ruleMap[code] ?? aiMap[code] ?? null;
  return {
    verdict:    src?.analysis?.verdict    ?? null,
    confidence: src?.analysis?.confidence ?? null,
  };
}

// A Buy with Low confidence is not actionable — treat it as Watch
function isConfidentBuy(verdict, confidence) {
  return (verdict === "Strong Buy" || verdict === "Buy") && confidence !== "Low";
}

// Left accent border — Low confidence Buy gets yellow (Watch), not green
function verdictBorder(verdict, confidence) {
  if (verdict === "Avoid") return "border-l-2 border-l-red-600";
  if ((verdict === "Strong Buy" || verdict === "Buy") && confidence === "Low")
    return "border-l-2 border-l-yellow-500/70";   // demoted to Watch
  if (verdict === "Strong Buy" || verdict === "Buy") return "border-l-2 border-l-green-500";
  if (verdict === "Hold")                            return "border-l-2 border-l-yellow-500/70";
  return "";
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function retColor(v) {
  if (v == null) return "text-gray-500";
  if (v >= 15)   return "text-green-300 font-semibold";
  if (v >= 8)    return "text-green-400";
  if (v >= 0)    return "text-green-500";
  if (v >= -5)   return "text-orange-400";
  return "text-red-400";
}
function cagrColor(v) {
  if (v == null) return "text-gray-500";
  if (v >= 18)   return "text-green-300 font-semibold";
  if (v >= 12)   return "text-green-400";
  if (v >= 8)    return "text-yellow-400";
  if (v >= 0)    return "text-orange-400";
  return "text-red-400";
}
function sharpeColor(s) {
  if (s == null) return "text-gray-500";
  if (s >= 1.5)  return "text-green-400";
  if (s >= 1)    return "text-green-500";
  if (s >= 0.5)  return "text-yellow-400";
  if (s >= 0)    return "text-orange-400";
  return "text-red-400";
}
function ddColor(dd) {
  if (dd == null) return "text-gray-500";
  if (dd >= -10)  return "text-green-400";
  if (dd >= -20)  return "text-yellow-400";
  if (dd >= -30)  return "text-orange-400";
  return "text-red-400";
}
function consColor(c) {
  if (c == null) return "text-gray-500";
  if (c >= 80)   return "text-green-400";
  if (c >= 60)   return "text-yellow-400";
  if (c >= 40)   return "text-orange-400";
  return "text-red-400";
}
function alphaColor(a) {
  if (a == null) return "text-gray-500";
  if (a >= 5)    return "text-lime-400 font-semibold";
  if (a >= 0)    return "text-green-400";
  if (a >= -5)   return "text-orange-400";
  return "text-red-400";
}

// ─── Score computation ────────────────────────────────────────────────────────
// Near-term momentum carries most weight; z-score is a conviction gate (multiplier),
// not just another additive term — so a Neutral/Cold fund gets discounted holistically.

function convictionMult(z) {
  if (z >= 1.5)  return 1.00;   // 🔥 Hot  — full credit
  if (z >= 0.5)  return 0.92;   // ↑ Warm
  if (z >= -0.5) return 0.82;   // → Neutral
  if (z >= -1.5) return 0.68;   // ↓ Cool
  return 0.55;                   // ❄ Cold  — heavy discount
}

function computeRawScore(fund, catZ) {
  const base =
    (fund.ret1w  ?? 0) * 0.25 +
    (fund.ret1m  ?? 0) * 0.20 +
    (fund.ret3m  ?? 0) * 0.15 +
    (fund.ret6m  ?? 0) * 0.10 +
    (fund.ret1y  ?? 0) * 0.10 +
    (fund.cagr5y ?? 0) * 0.05 +
    Math.min(Math.max(fund.sharpe ?? 0, 0), 2) * 5 * 0.05;
  return base * convictionMult(catZ ?? 0);
}

function buildMfPicks(mfData) {
  const raw = mfData.categories
    .map((cat) => {
      const catZ = cat.median.z1w ?? 0;
      const top  = [...cat.funds]
        .map((f) => ({ ...f, rawScore: computeRawScore(f, catZ), catZ, category: cat.category }))
        .sort((a, b) => b.rawScore - a.rawScore)[0];
      return top ?? null;
    })
    .filter(Boolean)
    .sort((a, b) => b.rawScore - a.rawScore);

  if (raw.length === 0) return raw;

  // Normalise rawScore → displayScore 20–100; store original momentum rank
  const scores = raw.map((f) => f.rawScore);
  const minS   = Math.min(...scores);
  const maxS   = Math.max(...scores);
  const range  = maxS - minS || 1;
  return raw.map((f, i) => ({
    ...f,
    momentumRank: i + 1,
    // Pure momentum rank score, 0–100 relative to peers this refresh
    displayScore: Math.round(((f.rawScore - minS) / range) * 100),
  }));
}

// ─── MF Score Badge ───────────────────────────────────────────────────────────
// Shows finalScore (momentum 65% + verdict signal 35%) when verdict is known,
// or raw momentum score while rationale is still loading.

function MfScoreBadge({ score, momentumScore, hasVerdict }) {
  let gradient;
  if      (score >= 75) gradient = "from-green-600 to-emerald-500";
  else if (score >= 55) gradient = "from-yellow-600 to-amber-500";
  else if (score >= 35) gradient = "from-orange-600 to-orange-500";
  else                  gradient = "from-red-700 to-red-600";
  return (
    <div
      className={`shrink-0 rounded-xl bg-gradient-to-br ${gradient} px-2.5 py-1.5 text-center shadow-sm`}
      title={hasVerdict ? `Composite: ${score} (momentum ${momentumScore} × 65% + verdict × 35%)` : `Momentum score: ${score}`}
    >
      <div className="text-lg font-bold tabular-nums leading-none text-white">{score}</div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-white/75">
        {hasVerdict ? "composite" : "momentum"}
      </div>
    </div>
  );
}

// ─── Return grid ──────────────────────────────────────────────────────────────

function ReturnGrid({ fund }) {
  return (
    <div className="mt-2 flex gap-2 overflow-x-auto pb-0.5">
      {RETURN_WINDOWS.map(({ label, key }) => {
        const v      = fund[key];
        const isCagr = key.startsWith("cagr");
        const color  = v != null ? (isCagr ? cagrColor(v) : retColor(v)) : "text-gray-600";
        return (
          <div key={key} className="min-w-[44px] shrink-0 rounded-lg bg-gray-800/60 px-2 py-1.5 text-center">
            <div className="mb-0.5 text-[9px] font-medium text-gray-500 leading-none">{label}</div>
            <div className={`text-xs tabular-nums leading-none ${color}`}>{fmt(v)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Risk metrics strip ───────────────────────────────────────────────────────

function RiskStrip({ fund }) {
  const metrics = [
    { label: "Sharpe",      value: fund.sharpe      != null ? fund.sharpe.toFixed(2)                          : "—", color: sharpeColor(fund.sharpe),      hint: "Return per unit of risk (≥1.5 excellent)" },
    { label: "Max DD",      value: fund.maxDd       != null ? `${fund.maxDd.toFixed(1)}%`                     : "—", color: ddColor(fund.maxDd),            hint: "Worst peak-to-trough decline" },
    { label: "Consistency", value: fund.consistency != null ? `${fund.consistency.toFixed(0)}%`               : "—", color: consColor(fund.consistency),    hint: "% of 12M rolling windows ≥12% CAGR" },
    { label: "α 5Y",        value: fund.alpha5y     != null ? `${fund.alpha5y >= 0 ? "+" : ""}${fund.alpha5y.toFixed(1)}pp` : "—", color: alphaColor(fund.alpha5y), hint: "Excess return vs benchmark, 5Y annualised" },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {metrics.map(({ label, value, color, hint }) => (
        <div key={label} className="min-w-[72px] flex-1 rounded-lg border border-gray-700/50 bg-gray-800/50 px-3 py-2" title={hint}>
          <div className="mb-0.5 text-[10px] text-gray-500">{label}</div>
          <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Analysis body ────────────────────────────────────────────────────────────

function AnalysisBody({ analysis }) {
  const verdictCls = VERDICT_STYLE[analysis.verdict] ?? "bg-gray-700/30 text-gray-300 border-gray-600/40";
  const confCls    = CONFIDENCE_STYLE[analysis.confidence] ?? "text-gray-400";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${verdictCls}`}>{analysis.verdict}</span>
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
              <li key={i} className="flex gap-2 text-xs text-gray-300"><span className="mt-0.5 shrink-0 text-green-500">↑</span>{pt}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-500">Bear Case</div>
          <ul className="space-y-1">
            {analysis.bear_case.map((pt, i) => (
              <li key={i} className="flex gap-2 text-xs text-gray-300"><span className="mt-0.5 shrink-0 text-red-500">↓</span>{pt}</li>
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

// ─── Rationale panels — always open inside Tier 2 ────────────────────────────

function RationaleSection({ ruleBased, aiRationale }) {
  if (!ruleBased && !aiRationale) return null;
  return (
    <div className="space-y-3">
      {ruleBased && (
        <div className="rounded-xl border border-gray-700/40 bg-gray-800/30 p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-gray-500">⚙</span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Daily Analysis</span>
            <span className={`ml-auto text-xs font-semibold ${CONFIDENCE_STYLE[ruleBased.analysis.confidence] ?? "text-gray-500"}`}>
              {ruleBased.analysis.verdict}
            </span>
          </div>
          <AnalysisBody analysis={ruleBased.analysis} />
          <div className="mt-3 text-[10px] text-gray-700">⚙ Rule-based · refreshes daily · Not financial advice</div>
        </div>
      )}
      {aiRationale && (
        <div className="rounded-xl border border-purple-800/40 bg-purple-900/10 p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-purple-400">✦</span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-purple-300">AI Analysis</span>
            <span className="text-[10px] text-purple-500 font-normal">{fmtDate(aiRationale.generated_at)}</span>
            <span className={`ml-auto text-xs font-semibold ${CONFIDENCE_STYLE[aiRationale.analysis.confidence] ?? "text-gray-500"}`}>
              {aiRationale.analysis.verdict}
            </span>
          </div>
          <AnalysisBody analysis={aiRationale.analysis} />
          <div className="mt-3 text-[10px] text-purple-900/80">Not financial advice</div>
        </div>
      )}
    </div>
  );
}

// ─── Section divider ──────────────────────────────────────────────────────────

function SectionDivider({ label, colorCls, lineCls, onClick }) {
  const inner = (
    <div className="flex items-center gap-3 py-1">
      <div className={`h-px flex-1 ${lineCls}`} />
      <span className={`text-[11px] font-bold uppercase tracking-wider ${colorCls}`}>{label}</span>
      <div className={`h-px flex-1 ${lineCls}`} />
    </div>
  );
  if (onClick) return <button onClick={onClick} className="w-full hover:opacity-80 transition">{inner}</button>;
  return inner;
}

// ─── Pick card ────────────────────────────────────────────────────────────────

function MfPickCard({ fund, ruleBased, aiRationale, verdict, confidence }) {
  const [expanded, setExpanded] = useState(false);
  const zl            = zLabel(fund.catZ);
  const isAvoid       = verdict === "Avoid";
  const isLowConfBuy  = (verdict === "Buy" || verdict === "Strong Buy") && confidence === "Low";
  const shownScore    = fund.finalScore ?? fund.displayScore;

  return (
    <div className={`rounded-2xl border border-gray-800 bg-gray-900 p-4 ${verdictBorder(verdict, confidence)} ${isAvoid ? "opacity-80" : ""}`}>
      {/* Avoid warning banner */}
      {isAvoid && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-800/30 bg-red-900/20 px-3 py-1.5">
          <span className="text-xs text-red-400">⚠</span>
          <span className="text-xs font-medium text-red-400">
            Avoid — strong returns but analysis flags concerns. Expand Details for rationale.
          </span>
        </div>
      )}
      {/* Low-confidence Buy banner — moved to Watch, explain why */}
      {isLowConfBuy && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-yellow-800/30 bg-yellow-900/10 px-3 py-1.5">
          <span className="text-xs text-yellow-400">⚠</span>
          <span className="text-xs font-medium text-yellow-400">
            Buy signal but Low confidence — moved to Watch. Conviction too weak to act.
          </span>
        </div>
      )}

      {/* ── Tier 1: always visible ──────────────────────────── */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* Name row */}
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold text-gray-600">#{fund.momentumRank} momentum</span>
            <span className="font-semibold leading-snug text-gray-100">{fund.label}</span>
          </div>
          {/* Tags */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">{fund.category}</span>
            {zl && <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${zl.bg}`}>{zl.text}</span>}
            {verdict && (
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${VERDICT_STYLE[verdict] ?? "bg-gray-700/30 text-gray-300 border-gray-600/40"}`}>
                {verdict}
              </span>
            )}
            {confidence && (
              <span className={`text-[10px] font-semibold ${CONFIDENCE_STYLE[confidence] ?? "text-gray-500"}`}>
                {confidence} confidence
              </span>
            )}
            {aiRationale && (
              <span className="rounded-full border border-purple-700/40 bg-purple-900/20 px-2 py-0.5 text-[10px] font-bold text-purple-400">✦ AI</span>
            )}
            {fund.latestNav && (
              <span className="text-[10px] text-gray-600">NAV ₹{fund.latestNav.toFixed(2)}</span>
            )}
          </div>
          {/* 7-window return grid */}
          <ReturnGrid fund={fund} />
        </div>

        {/* Score + toggle */}
        <div className="shrink-0 flex flex-col items-end gap-2 mt-0.5">
          {shownScore != null && (
            <MfScoreBadge
              score={shownScore}
              momentumScore={fund.displayScore}
              hasVerdict={fund.finalScore != null}
            />
          )}
          <button
            onClick={() => setExpanded((e) => !e)}
            className="rounded-lg bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-400 transition hover:bg-gray-700 hover:text-gray-200"
          >
            {expanded ? "Hide ▲" : "Details ▾"}
          </button>
        </div>
      </div>

      {/* ── Tier 2: risk + rationale ────────────────────────── */}
      {expanded && (
        <div className="mt-3 space-y-3 border-t border-gray-800/60 pt-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Risk Metrics</div>
            <RiskStrip fund={fund} />
          </div>
          <RationaleSection ruleBased={ruleBased} aiRationale={aiRationale} />
        </div>
      )}
    </div>
  );
}

// ─── Shared UI ────────────────────────────────────────────────────────────────

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

export default function MfPicks() {
  const { user }                                                    = useAuth();
  const { data: mfData, builtAt, loading: mfLoading, error: mfError } = useOutletContext();

  const [ruleRationale, setRuleRationale] = useState({});
  const [aiRationale,   setAiRationale]   = useState({});
  const [ratLoading,    setRatLoading]    = useState(true);
  const [avoidOpen,     setAvoidOpen]     = useState(true);

  useEffect(() => {
    Promise.all([
      supabase.from("pick_rationales").select("*").order("run_date", { ascending: false }).order("rank").limit(10),
      supabase.from("pick_ai_rationales").select("*").order("rank"),
    ]).then(([rule, ai]) => {
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
    }).finally(() => setRatLoading(false));
  }, []);

  if (mfLoading) return <Spinner />;
  if (mfError)   return <ErrorBox msg={mfError} />;
  if (!mfData)   return <ErrorBox msg="No MF data yet — the first refresh job hasn't completed." />;

  const mfPicks = buildMfPicks(mfData);

  // Verdict contributes 35% of final score; confidence scales that contribution:
  //   High confidence Buy  → 80 pts   Medium → 70   Low → 56 (≈ Hold territory)
  //   High confidence SBuy → 100 pts  Medium → 88   Low → 70
  // This means a Low confidence Buy barely lifts the score above Hold.
  function verdictComponent(verdict, confidence) {
    const base     = { "Strong Buy": 100, "Buy": 80, "Hold": 50, "Avoid": 15 }[verdict] ?? 50;
    const confMult = { "High": 1.00, "Medium": 0.875, "Low": 0.70 }[confidence] ?? 0.875;
    return Math.round(base * confMult);
  }

  // After rationale loads, attach verdict + confidence + finalScore, then section
  const sections = ratLoading ? null : (() => {
    const withVerdict = mfPicks.map((f) => {
      const { verdict, confidence } = resolveAnalysis(f.code, ruleRationale, aiRationale);
      const verdictPart = verdictComponent(verdict, confidence);
      const finalScore  = Math.round(f.displayScore * 0.65 + verdictPart * 0.35);
      return { ...f, verdict, confidence, finalScore };
    });
    const byFinal = (a, b) => b.finalScore - a.finalScore;
    return {
      // Only confident Buys go to the Buy section
      buy:   withVerdict.filter((f) => isConfidentBuy(f.verdict, f.confidence)).sort(byFinal),
      // Hold + unrated + Low-confidence Buys all go to Watch
      hold:  withVerdict.filter((f) => !isConfidentBuy(f.verdict, f.confidence) && f.verdict !== "Avoid").sort(byFinal),
      avoid: withVerdict.filter((f) => f.verdict === "Avoid").sort(byFinal),
    };
  })();

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">MF Top Picks</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            One fund per category · sorted by analyst verdict, then momentum score
            {builtAt && <> · updated {timeAgo(builtAt)}</>}
          </p>

          {/* Verdict count chips — appear once rationale loads */}
          {sections && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {sections.buy.length > 0 && (
                <span className="rounded-full border border-green-700/40 bg-green-900/20 px-2.5 py-0.5 text-[11px] font-semibold text-green-400">
                  ✓ {sections.buy.length} Buy — actionable
                </span>
              )}
              {sections.buy.length === 0 && (
                <span className="rounded-full border border-gray-700 bg-gray-800 px-2.5 py-0.5 text-[11px] text-gray-500">
                  No confident Buy signals today
                </span>
              )}
              {sections.hold.length > 0 && (
                <span className="rounded-full border border-yellow-800/40 bg-yellow-900/10 px-2.5 py-0.5 text-[11px] font-medium text-yellow-500">
                  ⏸ {sections.hold.length} Watch
                </span>
              )}
              {sections.avoid.length > 0 && (
                <span className="rounded-full border border-red-800/40 bg-red-900/10 px-2.5 py-0.5 text-[11px] font-medium text-red-400">
                  ⚠ {sections.avoid.length} Avoid
                </span>
              )}
            </div>
          )}
        </div>
        <Link to="/glossary" className="mt-1 shrink-0 text-[10px] text-gray-600 hover:text-blue-400 transition">
          What do these terms mean? →
        </Link>
      </div>

      {/* ── Picks — flat while loading, sectioned after ── */}
      {!sections ? (
        /* Loading state: show in raw momentum order, no verdict styling yet */
        <div className="space-y-3">
          {mfPicks.map((fund) => (
            <MfPickCard
              key={fund.code}
              fund={fund}
              ruleBased={null}
              aiRationale={null}
              verdict={null}
              confidence={null}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── BUY section — confident Buys only ────────────── */}
          {sections.buy.length > 0 && (
            <div className="space-y-3">
              <SectionDivider
                label={`✓ ${sections.buy.length} Buy Signal${sections.buy.length !== 1 ? "s" : ""} — consider adding to portfolio`}
                colorCls="text-green-400"
                lineCls="bg-green-800/30"
              />
              {sections.buy.map((fund) => (
                <MfPickCard
                  key={fund.code}
                  fund={fund}
                  ruleBased={ruleRationale[fund.code] ?? null}
                  aiRationale={aiRationale[fund.code] ?? null}
                  verdict={fund.verdict}
                  confidence={fund.confidence}
                />
              ))}
            </div>
          )}

          {/* ── WATCH section — Hold + Low-confidence Buys ───── */}
          {sections.hold.length > 0 && (
            <div className="space-y-3">
              <SectionDivider
                label={`⏸ ${sections.hold.length} Watch — hold or low-confidence signals`}
                colorCls="text-yellow-500"
                lineCls="bg-yellow-800/25"
              />
              {sections.hold.map((fund) => (
                <MfPickCard
                  key={fund.code}
                  fund={fund}
                  ruleBased={ruleRationale[fund.code] ?? null}
                  aiRationale={aiRationale[fund.code] ?? null}
                  verdict={fund.verdict ?? "Hold"}
                  confidence={fund.confidence}
                />
              ))}
            </div>
          )}

          {/* ── AVOID section ────────────────────────────────── */}
          {sections.avoid.length > 0 && (
            <div className="space-y-3">
              <SectionDivider
                label={`⚠ ${sections.avoid.length} Avoid — strong momentum but analysis flags risks ${avoidOpen ? "▲" : "▾"}`}
                colorCls="text-red-400"
                lineCls="bg-red-800/25"
                onClick={() => setAvoidOpen((o) => !o)}
              />
              {avoidOpen && sections.avoid.map((fund) => (
                <MfPickCard
                  key={fund.code}
                  fund={fund}
                  ruleBased={ruleRationale[fund.code] ?? null}
                  aiRationale={aiRationale[fund.code] ?? null}
                  verdict="Avoid"
                  confidence={fund.confidence}
                />
              ))}
            </div>
          )}

          {/* Edge case: no verdicts at all (empty rationale tables) */}
          {sections.buy.length === 0 && sections.hold.length === 0 && sections.avoid.length === 0 && (
            <div className="space-y-3">
              {mfPicks.map((fund) => (
                <MfPickCard
                  key={fund.code}
                  fund={fund}
                  ruleBased={ruleRationale[fund.code] ?? null}
                  aiRationale={aiRationale[fund.code] ?? null}
                  verdict={null}
                  confidence={null}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <p className="pt-2 text-[10px] text-gray-700">
        Momentum signals only — not financial advice. Past performance does not guarantee future returns.
      </p>
    </div>
  );
}
