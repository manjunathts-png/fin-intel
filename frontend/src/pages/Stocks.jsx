import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { buildSectorView } from "./StockRadar";

const SUB_TABS = [
  { to: "picks",    label: "⭐ Picks",             desc: "Top stocks by composite signal score" },
  { to: "radar",    label: "🗺 Sector Radar",      desc: "Sectors ranked by signal density" },
  { to: "all",      label: "🔍 All Stocks",        desc: "Sortable & filterable full universe" },
  { to: "hotspots", label: "🔥 Signal Hotspots",   desc: "Sector × signal heatmap — spot clusters" },
];

export default function Stocks() {
  const [data,    setData]    = useState(null);
  const [builtAt, setBuiltAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    supabase
      .from("radar_cache")
      .select("data,built_at")
      .eq("key", "stock_picks")
      .maybeSingle()
      .then(({ data: row, error: e }) => {
        if (e) { setError(e.message); return; }
        if (row) { setData(row.data); setBuiltAt(row.built_at); }
      })
      .finally(() => setLoading(false));
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
