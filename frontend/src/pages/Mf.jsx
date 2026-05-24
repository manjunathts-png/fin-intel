import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { supabase } from "../lib/supabase";

const SUB_TABS = [
  { to: "picks",       label: "⭐ Picks",            desc: "Top fund per category — best entry point" },
  { to: "radar",       label: "📊 Category Radar",  desc: "All categories ranked by return & risk" },
  { to: "risk",        label: "🎯 Risk-Adjusted",   desc: "Every fund sorted by Sharpe / Calmar / Consistency" },
  { to: "compounders", label: "🏆 Compounders",      desc: "Highest long-term CAGR + consistent performers" },
];

export default function Mf() {
  const [data,    setData]    = useState(null);
  const [builtAt, setBuiltAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    supabase
      .from("radar_cache")
      .select("data,built_at")
      .eq("key", "mf_radar")
      .single()
      .then(({ data: row, error: err }) => {
        if (err) { setError(err.message); return; }
        setData(row.data);
        setBuiltAt(row.built_at);
      })
      .finally(() => setLoading(false));
  }, []);

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

      {/* Sub-route content; data shared via outlet context */}
      <Outlet context={{ data, builtAt, loading, error }} />
    </div>
  );
}
