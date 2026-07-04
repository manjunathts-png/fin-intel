import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { buildSectorView } from "./StockRadar";

const SUB_TABS = [
  { to: "picks",        label: "⭐ Picks",           desc: "Top stocks by composite signal score" },
  { to: "radar",        label: "🗺 Sector Radar",    desc: "Sectors ranked by signal density" },
  { to: "all",          label: "🔍 All Stocks",      desc: "Sortable & filterable full universe" },
  { to: "hotspots",     label: "🔥 Signal Hotspots", desc: "Sector × signal heatmap — spot clusters" },
  { to: "track-record", label: "🎯 Track Record",    desc: "Realized returns of the published picks" },
  { to: "watchlist",    label: "👁 Watchlist",       desc: "Your holdings — hold / trim / exit verdicts" },
];

export default function Stocks() {
  const [data,    setData]    = useState(null);
  const [builtAt, setBuiltAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    // Two-phase fetch: poll built_at only (< 100 bytes) every 5 min.
    // Only download the full data payload when built_at actually changed.
    // Stock picks update ~7×/day; this cuts Supabase bandwidth by ~97%.
    let lastBuiltAt = null;

    async function checkAndLoad() {
      try {
        // Phase 1: lightweight freshness check
        const { data: meta, error: metaErr } = await supabase
          .from("radar_cache")
          .select("built_at")
          .eq("key", "stock_picks")
          .maybeSingle();
        if (metaErr) throw metaErr;
        if (!meta) return;

        // Phase 2: full payload — only when data has changed
        if (meta.built_at === lastBuiltAt) return;

        const { data: row, error: rowErr } = await supabase
          .from("radar_cache")
          .select("data,built_at")
          .eq("key", "stock_picks")
          .maybeSingle();
        if (rowErr) throw rowErr;
        if (row) {
          setData(row.data);
          setBuiltAt(row.built_at);
          lastBuiltAt = row.built_at;
        }
        setError(null);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }

    checkAndLoad();

    // Re-check every 5 minutes. Full download only happens ~7×/day when data changes.
    const timer = setInterval(checkAndLoad, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // Pre-compute sector aggregates so all sub-routes share the same derived data
  const sectors = useMemo(() => buildSectorView(data?.all ?? []), [data]);

  return (
    <div className="space-y-4">
      {/* Sub-tab strip */}
      <div className="overflow-x-auto -mx-1 px-1">
        <div className="flex gap-1 rounded-xl bg-gray-900 p-1 min-w-max">
          {SUB_TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              title={t.desc}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition ${
                  isActive
                    ? "bg-gray-700 text-white"
                    : "text-gray-500 hover:text-gray-300"
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </div>
      </div>

      {/* Sub-route content; data + sectors shared via outlet context */}
      <Outlet context={{ data, builtAt, loading, error, sectors }} />
    </div>
  );
}
