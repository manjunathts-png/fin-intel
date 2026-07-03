import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { buildPickMap, evaluateHolding, normalizeSymbol, VERDICT_META } from "../lib/exitSignals";

// Holdings live in localStorage only — no server round-trip, no schema change.
const LS_KEY = "finintel_watchlist_v1";

function loadHoldings() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveHoldings(holdings) {
  localStorage.setItem(LS_KEY, JSON.stringify(holdings));
}

const fmtInr = (v) => (v == null ? "—" : `₹${Number(v).toLocaleString("en-IN")}`);

function AddHoldingForm({ picks, onAdd, existing }) {
  const [symbol, setSymbol] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [buyDate, setBuyDate] = useState("");
  const [err, setErr] = useState(null);

  function submit(e) {
    e.preventDefault();
    const sym = normalizeSymbol(symbol);
    if (!sym) { setErr("Enter a symbol"); return; }
    if (existing.has(sym)) { setErr(`${sym} is already on the watchlist`); return; }
    const price = buyPrice === "" ? null : parseFloat(buyPrice);
    if (price != null && (!isFinite(price) || price <= 0)) { setErr("Buy price must be a positive number"); return; }
    if (buyDate && new Date(buyDate) > new Date()) { setErr("Buy date is in the future"); return; }
    onAdd({ symbol: sym, buyPrice: price, buyDate: buyDate || null });
    setSymbol(""); setBuyPrice(""); setBuyDate(""); setErr(null);
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      <div className="mb-2 text-sm font-semibold text-gray-200">Add a holding</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-gray-500">
          Symbol (NSE)
          <input
            list="watchlist-symbols"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="e.g. TCS"
            className="w-36 rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
          />
        </label>
        <datalist id="watchlist-symbols">
          {picks.map((p) => (
            <option key={p.symbol} value={normalizeSymbol(p.symbol)}>{p.label}</option>
          ))}
        </datalist>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-gray-500">
          Buy price (optional)
          <input
            type="number" min="0" step="0.05" value={buyPrice}
            onChange={(e) => setBuyPrice(e.target.value)}
            placeholder="₹"
            className="w-28 rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-gray-500">
          Buy date (optional)
          <input
            type="date" value={buyDate} max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setBuyDate(e.target.value)}
            className="rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
          />
        </label>
        <button type="submit" className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500">
          Add
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
      <p className="mt-2 text-[10px] text-gray-600">
        Stored only in this browser (localStorage) — nothing is uploaded.
      </p>
    </form>
  );
}

function HoldingCard({ holding, result, onRemove }) {
  const [open, setOpen] = useState(false);
  const { verdict, reasons, pick, ltcg } = result;
  const meta = VERDICT_META[verdict];
  const price = pick?.close ?? null;
  const pnlPct = holding.buyPrice && price != null ? ((price - holding.buyPrice) / holding.buyPrice) * 100 : null;

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-semibold text-gray-100">{pick?.label ?? holding.symbol}</span>
            <span className="font-mono text-[10px] text-gray-600">{holding.symbol}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${meta.cls}`}>{meta.label}</span>
            {pick && <span className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">#{pick.rank}</span>}
            {ltcg?.status === "long_term" && (
              <span className="rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-500" title={`Held ${ltcg.heldDays} days`}>LTCG</span>
            )}
            {ltcg?.status === "short_term" && ltcg.daysToLtcg <= 60 && (
              <span className="rounded border border-yellow-800/40 bg-yellow-900/20 px-1.5 py-0.5 text-[10px] text-yellow-400" title="Selling now realises short-term gains">
                LTCG in {ltcg.daysToLtcg}d
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
            {price != null && <span>Now {fmtInr(price)}</span>}
            {holding.buyPrice != null && <span>Bought {fmtInr(holding.buyPrice)}</span>}
            {pnlPct != null && (
              <span className={pnlPct >= 0 ? "text-green-400" : "text-red-400"}>
                {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
              </span>
            )}
            {pick?.daysInTop50 >= 1 && <span className="text-gray-500">{pick.daysInTop50}d in top 50</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={() => setOpen((o) => !o)} className="rounded-lg bg-gray-800 px-2.5 py-1 text-xs text-gray-400 transition hover:bg-gray-700 hover:text-gray-200">
            {open ? "Hide ▲" : "Why ▾"}
          </button>
          <button
            onClick={onRemove}
            title="Remove from watchlist"
            className="rounded-lg bg-gray-800 px-2 py-1 text-xs text-gray-500 transition hover:bg-red-900/40 hover:text-red-400"
          >
            ✕
          </button>
        </div>
      </div>
      {open && (
        <ul className="mt-3 space-y-1 border-t border-gray-800/60 pt-3 text-xs text-gray-400">
          {reasons.map((r, i) => (
            <li key={i} className="flex gap-1.5"><span className="text-gray-600">•</span><span>{r}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Watchlist() {
  const { data, loading, error } = useOutletContext();
  const [holdings, setHoldings] = useState(loadHoldings);

  const pickMap = useMemo(() => buildPickMap(data), [data]);
  const regime = data?.regime ?? null;

  const results = useMemo(
    () => holdings.map((h) => ({ holding: h, result: evaluateHolding(h, pickMap, regime) })),
    [holdings, pickMap, regime]
  );

  // Worst first — exits float to the top
  const sorted = [...results].sort((a, b) => b.result.severity - a.result.severity);
  const counts = results.reduce((acc, { result }) => {
    acc[result.verdict] = (acc[result.verdict] ?? 0) + 1;
    return acc;
  }, {});

  function add(h) {
    const next = [...holdings, h];
    setHoldings(next); saveHoldings(next);
  }
  function remove(symbol) {
    const next = holdings.filter((h) => h.symbol !== symbol);
    setHoldings(next); saveHoldings(next);
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (error) return <p className="text-sm text-red-400">Could not load stock data: {error}</p>;

  return (
    <div className="space-y-4">
      <div className="text-[11px] text-gray-500">
        Your holdings, judged by today's pipeline: rank, regime, trend and overextension become
        hold / trim / exit verdicts. The pipeline only publishes entries — this is the other half.
      </div>

      {regime?.regime === "risk_off" && (
        <div className="rounded-xl border border-red-800/40 bg-red-900/20 px-4 py-2.5 text-xs text-red-300">
          ⚠ Regime is <strong>risk_off</strong> (breadth {regime.breadthPct}% above 200DMA
          {regime.indiaVix != null ? `, VIX ${regime.indiaVix}` : ""}) — weak holdings are flagged for exit,
          strong ones for hold-don't-add.
        </div>
      )}

      {holdings.length > 0 && (
        <div className="flex flex-wrap gap-2 text-[11px]">
          {["EXIT", "TRIM", "REVIEW", "HOLD", "ADD"].map((v) =>
            counts[v] ? (
              <span key={v} className={`rounded-full border px-2.5 py-1 font-semibold ${VERDICT_META[v].cls}`}>
                {counts[v]} {VERDICT_META[v].label}
              </span>
            ) : null
          )}
        </div>
      )}

      <AddHoldingForm
        picks={data?.all ?? []}
        existing={new Set(holdings.map((h) => h.symbol))}
        onAdd={add}
      />

      {sorted.length === 0 ? (
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
          No holdings yet — add the stocks you own to get exit/hold verdicts against today's signals.
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map(({ holding, result }) => (
            <HoldingCard
              key={holding.symbol}
              holding={holding}
              result={result}
              onRemove={() => remove(holding.symbol)}
            />
          ))}
        </div>
      )}

      <p className="text-[10px] text-gray-600">
        Verdicts are rule-based on today's published data and are not investment advice. Stocks outside the
        Nifty-500 scan always show as "Review" — the system simply has no signal on them.
      </p>
    </div>
  );
}
