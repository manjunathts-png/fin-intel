import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  LineChart,
  Bar,
  Line,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

// Chart fills — deeper steps than the text accents so they sit correctly on
// the gray-900 surface (validated for lightness/contrast/CVD):
//   polarity: green #16a34a / red #ef4444 (sign also encoded by position vs 0)
//   two-series lines: strategy #3b82f6 vs Nifty #d97706
const POS = "#16a34a", NEG = "#ef4444", STRAT = "#3b82f6", BENCH = "#d97706";

const GRID = { strokeDasharray: "3 3", stroke: "#1f2937", vertical: false };
const AXIS = { stroke: "#4b5563", fontSize: 10, tickLine: false };
const TIP = {
  contentStyle: { backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "#9ca3af" },
};

const fmtPct = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const fmtDate = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "");

function StatTile({ label, value, sub, color }) {
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color ?? "text-gray-100"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}

function Panel({ title, sub, children }) {
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      <div className="mb-1 text-sm font-semibold text-gray-200">{title}</div>
      {sub && <div className="mb-3 text-[11px] text-gray-500">{sub}</div>}
      {children}
    </div>
  );
}

function HorizonTable({ summary }) {
  const rows = [
    { key: "ret_5d", label: "5 days" },
    { key: "ret_10d", label: "10 days" },
    { key: "ret_21d", label: "21 days" },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500">
            <th className="py-1.5 pr-3">Horizon</th>
            <th className="py-1.5 pr-3 text-right">Top-10 net</th>
            <th className="py-1.5 pr-3 text-right">Hit rate</th>
            <th className="py-1.5 pr-3 text-right">Top-50 net</th>
            <th className="py-1.5 pr-3 text-right">Hit rate</th>
            <th className="py-1.5 text-right">n (top-10)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, label }) => {
            const s = summary?.[key];
            const t10 = s?.top10, t50 = s?.top50;
            const col = (v) => ((v ?? 0) >= 0 ? "text-green-400" : "text-red-400");
            return (
              <tr key={key} className="border-t border-gray-800/60 text-gray-300">
                <td className="py-1.5 pr-3">{label}</td>
                <td className={`py-1.5 pr-3 text-right tabular-nums font-semibold ${col(t10?.meanNet)}`}>{fmtPct(t10?.meanNet)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{t10?.hitRateNet != null ? `${t10.hitRateNet.toFixed(0)}%` : "—"}</td>
                <td className={`py-1.5 pr-3 text-right tabular-nums ${col(t50?.meanNet)}`}>{fmtPct(t50?.meanNet)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{t50?.hitRateNet != null ? `${t50.hitRateNet.toFixed(0)}%` : "—"}</td>
                <td className="py-1.5 text-right tabular-nums text-gray-500">{t10?.n ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TrackRecord() {
  const [tr, setTr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: row, error: err } = await supabase
          .from("radar_cache").select("data,built_at").eq("key", "track_record").maybeSingle();
        if (err) throw err;
        if (alive) setTr(row?.data ?? null);
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (loading) return <p className="text-sm text-gray-500">Loading track record…</p>;
  if (error) return <p className="text-sm text-red-400">Could not load track record: {error}</p>;
  if (!tr || !tr.series?.length) {
    return (
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6 text-sm text-gray-400">
        <p className="font-semibold text-gray-200">No track record yet</p>
        <p className="mt-1">
          The <code className="text-gray-500">track_record</code> cache is built by the nightly refresh once
          <code className="mx-1 text-gray-500">pick_history</code> has resolved outcomes (21 trading days after the
          first snapshot). Check back after the pipeline has been live for a month.
        </p>
      </div>
    );
  }

  const s21 = tr.summary?.ret_21d;
  const rotFinal = tr.rotation?.length ? tr.rotation[tr.rotation.length - 1] : null;
  const beatNifty = tr.series.filter((s) => s.top10 != null && s.nifty != null);
  const winVsNifty = beatNifty.length
    ? (beatNifty.filter((s) => s.top10 > s.nifty).length / beatNifty.length) * 100
    : null;

  return (
    <div className="space-y-4">
      <div className="text-[11px] text-gray-500">
        Realized performance of the published picks. Entry = first close <em>after</em> pick date; net returns
        deduct {tr.params?.costPct}% round-trip cost. Overlapping daily cohorts — the rotation curve below
        compounds non-overlapping ~monthly legs only.
      </div>

      {/* ── Stat tiles ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Top-10 mean (21d, net)"
          value={fmtPct(s21?.top10?.meanNet)}
          sub={`${s21?.top10?.n ?? 0} resolved picks`}
          color={(s21?.top10?.meanNet ?? 0) >= 0 ? "text-green-400" : "text-red-400"}
        />
        <StatTile
          label="Hit rate (21d, net)"
          value={s21?.top10?.hitRateNet != null ? `${s21.top10.hitRateNet.toFixed(0)}%` : "—"}
          sub="top-10 picks ending positive"
        />
        <StatTile
          label="Cohorts vs Nifty"
          value={winVsNifty != null ? `${winVsNifty.toFixed(0)}%` : "—"}
          sub="daily top-10 cohorts beating Nifty (21d)"
          color={(winVsNifty ?? 0) >= 50 ? "text-green-400" : "text-red-400"}
        />
        <StatTile
          label="₹100 rotated monthly"
          value={rotFinal ? `₹${rotFinal.strategy.toFixed(0)}` : "—"}
          sub={rotFinal ? `vs ₹${rotFinal.nifty.toFixed(0)} in Nifty` : "needs 3+ resolved months"}
          color={rotFinal && rotFinal.strategy >= rotFinal.nifty ? "text-green-400" : "text-red-400"}
        />
      </div>

      {/* ── Cohort returns over time ───────────────────────────────── */}
      <Panel
        title="Daily cohort forward returns (21d, net)"
        sub="Each bar = mean net 21-day return of that day's top-10 picks. Amber line = Nifty over the same window."
      >
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={tr.series} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="date" tickFormatter={fmtDate} {...AXIS} minTickGap={28} />
            <YAxis tickFormatter={(v) => `${v}%`} {...AXIS} />
            <Tooltip {...TIP} formatter={(v, name) => [fmtPct(v), name]} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={0} stroke="#374151" />
            <Bar dataKey="top10" name="Top-10 cohort" fill={POS} maxBarSize={14} radius={[4, 4, 0, 0]}>
              {tr.series.map((s, i) => (
                <Cell key={i} fill={(s.top10 ?? 0) >= 0 ? POS : NEG} />
              ))}
            </Bar>
            <Line dataKey="nifty" name="Nifty 50" stroke={BENCH} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Rotation equity curve ────────────────────────────────── */}
        <Panel
          title="₹100 rotated into the top-10, monthly"
          sub="Non-overlapping ~21-trading-day legs, net of costs, vs the same money in Nifty."
        >
          {tr.rotation?.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={tr.rotation} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="date" tickFormatter={fmtDate} {...AXIS} minTickGap={28} />
                <YAxis domain={["auto", "auto"]} {...AXIS} />
                <Tooltip {...TIP} formatter={(v, name) => [`₹${v.toFixed(1)}`, name]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line dataKey="strategy" name="Top-10 rotation" stroke={STRAT} strokeWidth={2} dot={{ r: 3 }} />
                <Line dataKey="nifty" name="Nifty 50" stroke={BENCH} strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="py-8 text-center text-xs text-gray-600">
              Needs at least 3 resolved non-overlapping months.
            </p>
          )}
        </Panel>

        {/* ── Return distribution ──────────────────────────────────── */}
        <Panel
          title="Per-pick outcome distribution (21d, net)"
          sub={`All ${tr.summary?.ret_21d?.top50?.n ?? 0} resolved top-50 picks.`}
        >
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={tr.distribution} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="label" {...AXIS} interval={0} angle={-20} textAnchor="end" height={40} />
              <YAxis {...AXIS} allowDecimals={false} />
              <Tooltip {...TIP} formatter={(v) => [v, "picks"]} />
              <Bar dataKey="count" name="Picks" fill={STRAT} maxBarSize={40} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Horizon table ────────────────────────────────────────── */}
        <Panel title="By horizon" sub="Pooled per-pick returns, net of costs.">
          <HorizonTable summary={tr.summary} />
        </Panel>

        {/* ── Rank bands ───────────────────────────────────────────── */}
        <Panel title="By rank band (21d, net)" sub="Does concentration in the very top pay?">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500">
                <th className="py-1.5 pr-3">Rank band</th>
                <th className="py-1.5 pr-3 text-right">Mean net</th>
                <th className="py-1.5 pr-3 text-right">Hit rate</th>
                <th className="py-1.5 text-right">n</th>
              </tr>
            </thead>
            <tbody>
              {(tr.rankBands ?? []).map((b) => (
                <tr key={b.band} className="border-t border-gray-800/60 text-gray-300">
                  <td className="py-1.5 pr-3">#{b.band}</td>
                  <td className={`py-1.5 pr-3 text-right tabular-nums font-semibold ${(b.meanNet ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {fmtPct(b.meanNet)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{b.hitRateNet != null ? `${b.hitRateNet.toFixed(0)}%` : "—"}</td>
                  <td className="py-1.5 text-right tabular-nums text-gray-500">{b.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <p className="text-[10px] text-gray-600">
        Updated {tr.asOf?.slice(0, 10)} · window {tr.params?.windowDays} days · {tr.cohorts} snapshot dates ·
        past performance is not a guarantee of future returns.
      </p>
    </div>
  );
}
