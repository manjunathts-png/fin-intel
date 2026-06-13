import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";

const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL ?? "";

const STATUS_ICON  = { ok: "✅", warn: "⚠️", critical: "🔴", unknown: "❔" };
const STATUS_COLOR = {
  ok:       "border-green-800/50 bg-green-900/10 text-green-400",
  warn:     "border-yellow-700/50 bg-yellow-900/10 text-yellow-400",
  critical: "border-red-800/50 bg-red-900/10 text-red-400",
  unknown:  "border-gray-700/50 bg-gray-800/40 text-gray-400",
};
const COMPONENT_LABEL = {
  sources:      "Data Sources",
  mfapi_data:   "mfapi.in NAV Data",
  freshness:    "Feature Freshness",
  ic_drift:     "Signal IC Drift",
  stock_model:  "Stock Model",
  mf_model:     "MF Model",
  outcomes:     "Realized P&L",
};

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const PAGE_LABELS = { "/mf": "MF Radar", "/stocks": "Stocks", "/picks": "Picks", "/admin": "Admin" };

const WINDOW_LABELS = { ret1w: "1W", ret1m: "1M", ret3m: "3M", ret6m: "6M", ret1y: "1Y", z1w: "Momentum z" };

function fmtEvent(event) {
  if (!event) return "—";
  if (event === "login")     return "🔑 Login";
  if (event === "logout")    return "🚪 Logout";
  if (event === "page_view") return "👁 Page view";
  if (event.startsWith("sort:")) {
    const [, col, dir] = event.split(":");
    return `↕ Sort by ${WINDOW_LABELS[col] ?? col} (${dir})`;
  }
  if (event.startsWith("expand:")) {
    return `▶ Expanded: ${event.slice(7)}`;
  }
  if (event.startsWith("tab:")) {
    const t = event.slice(4);
    return `⇄ Tab: ${t === "mf" ? "MF Picks" : "Stock Picks"}`;
  }
  return event;
}

function StatCard({ label, value, sub }) {
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="mt-0.5 text-sm font-medium text-gray-300">{label}</div>
      {sub && <div className="mt-1 text-xs text-gray-600">{sub}</div>}
    </div>
  );
}

function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function Admin() {
  const { user } = useAuth();
  const [profiles,    setProfiles]    = useState([]);
  const [events,      setEvents]      = useState([]);
  const [health,      setHealth]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [evtLoading,  setEvtLoading]  = useState(false);
  const [tab,         setTab]         = useState("health");

  const today = toLocalDateStr(new Date());
  const [dateFrom, setDateFrom] = useState("2025-01-01");
  const [dateTo,   setDateTo]   = useState(today);

  if (user && user.email !== ADMIN_EMAIL) return <Navigate to="/mf" replace />;

  async function loadEvents(from, to) {
    setEvtLoading(true);
    const fromISO = new Date(from + "T00:00:00").toISOString();
    const toISO   = new Date(to   + "T23:59:59").toISOString();
    const { data: e } = await supabase
      .from("user_events")
      .select("*")
      .neq("email", ADMIN_EMAIL)
      .gte("created_at", fromISO)
      .lte("created_at", toISO)
      .order("created_at", { ascending: false });
    setEvents(e ?? []);
    setEvtLoading(false);
  }

  useEffect(() => {
    async function load() {
      const [{ data: p }, { data: h }] = await Promise.all([
        supabase.from("profiles").select("*").neq("email", ADMIN_EMAIL).order("created_at", { ascending: false }),
        // latest run_date only — get the most recent date first, then filter
        supabase.from("system_health").select("*").order("run_date", { ascending: false }).limit(50),
      ]);
      setProfiles(p ?? []);
      // Keep only the most recent run per component
      const byComponent = {};
      for (const row of (h ?? [])) {
        if (!byComponent[row.component]) byComponent[row.component] = row;
      }
      setHealth(Object.values(byComponent));
      setLoading(false);
    }
    load();
    loadEvents(dateFrom, dateTo);
  }, []);

  if (loading) return <Spinner />;

  // Derived stats
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const activeToday = new Set(
    events.filter((e) => new Date(e.created_at) >= todayStart).map((e) => e.user_id)
  ).size;
  const logins = events.filter((e) => e.event === "login").length;

  // Per-user event counts
  const eventsByUser = events.reduce((acc, e) => {
    acc[e.user_id] = (acc[e.user_id] ?? 0) + 1;
    return acc;
  }, {});

  // Page activity (all events with a page)
  const pageActivity = events
    .filter((e) => e.page)
    .reduce((acc, e) => { acc[e.page] = (acc[e.page] ?? 0) + 1; return acc; }, {});
  const topPages = Object.entries(pageActivity).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">⚙ Admin Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          {profiles.length} users · {events.length} events tracked
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Users"    value={profiles.length} />
        <StatCard label="Active Today"   value={activeToday} />
        <StatCard label="Total Logins"   value={logins} />
        <StatCard label="Events"   value={events.length} sub={`${dateFrom} → ${dateTo}`} />
      </div>

      {/* Page popularity */}
      {topPages.length > 0 && (
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5">
          <div className="mb-3 text-sm font-semibold text-gray-400 uppercase tracking-wider">Page Views</div>
          <div className="flex flex-wrap gap-3">
            {topPages.map(([page, count]) => (
              <div key={page} className="flex items-center gap-2 rounded-xl bg-gray-800 px-3 py-2">
                <span className="text-sm text-gray-200">{PAGE_LABELS[page] ?? page}</span>
                <span className="tabular-nums text-sm font-bold text-blue-400">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-800 pb-0">
        {["health", "users", "activity"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition border-b-2 -mb-px ${
              tab === t
                ? "border-blue-500 text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {t === "users"    ? `Users (${profiles.length})`
           : t === "activity" ? `Activity (${evtLoading ? "…" : events.length})`
           : "System Health"}
          </button>
        ))}
      </div>

      {tab === "health" && <HealthTab health={health} />}

      {tab === "users" && (
        <div className="overflow-hidden rounded-2xl border border-gray-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-800/80">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">User</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 hidden sm:table-cell">Signed Up</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Last Seen</th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">Events</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} className="border-t border-gray-800 hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      {p.avatar_url
                        ? <img src={p.avatar_url} alt="" className="h-7 w-7 rounded-full shrink-0" referrerPolicy="no-referrer" />
                        : <div className="h-7 w-7 rounded-full bg-gray-700 shrink-0 flex items-center justify-center text-xs text-gray-400">{p.email[0].toUpperCase()}</div>
                      }
                      <div className="min-w-0">
                        <div className="truncate font-medium text-gray-100">{p.full_name || p.email}</div>
                        {p.full_name && <div className="truncate text-xs text-gray-500">{p.email}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400 hidden sm:table-cell">{fmtDate(p.created_at)}</td>
                  <td className="px-4 py-3 text-xs text-gray-400">{timeAgo(p.last_seen_at)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-sm font-semibold text-gray-300">
                    {eventsByUser[p.id] ?? 0}
                  </td>
                </tr>
              ))}
              {profiles.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-600">No users yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "activity" && (
        <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-gray-800 bg-gray-900 p-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 uppercase tracking-wider">From</label>
            <input
              type="date"
              value={dateFrom}
              max={dateTo}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 uppercase tracking-wider">To</label>
            <input
              type="date"
              value={dateTo}
              min={dateFrom}
              max={today}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={() => loadEvents(dateFrom, dateTo)}
            disabled={evtLoading}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition"
          >
            {evtLoading ? "Loading…" : "Apply"}
          </button>
          <span className="ml-auto text-xs text-gray-500">{events.length} events in range</span>
        </div>
      )}

      {tab === "activity" && (
        <div className="overflow-hidden rounded-2xl border border-gray-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-800/80">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">User</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Action</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 hidden sm:table-cell">Page</th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">When</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-gray-800 hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-2.5 text-xs text-gray-400 max-w-[140px] truncate">{e.email}</td>
                  <td className="px-4 py-2.5 text-xs font-medium text-gray-200">
                    {fmtEvent(e.event)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 hidden sm:table-cell">
                    {e.page ? (PAGE_LABELS[e.page] ?? e.page) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-gray-500 tabular-nums">{timeAgo(e.created_at)}</td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-600">No events yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HealthTab({ health }) {
  if (!health.length) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-800 p-10 text-center space-y-2">
        <p className="text-sm text-gray-500">No health data yet.</p>
        <p className="text-xs text-gray-600">
          The nightly pipeline writes here after each run (5:00 AM IST).
          Dispatch <code className="text-gray-400">all</code> or <code className="text-gray-400">stocks</code> manually to populate it now.
        </p>
      </div>
    );
  }

  const ORDER = ["sources","mfapi_data","freshness","ic_drift","stock_model","mf_model","outcomes"];
  const sorted = [...health].sort((a, b) => {
    const ia = ORDER.indexOf(a.component), ib = ORDER.indexOf(b.component);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const SORDER = { critical: 0, warn: 1, unknown: 2, ok: 3 };
  const overall = sorted.reduce((worst, r) =>
    (SORDER[r.status] ?? 2) < (SORDER[worst] ?? 2) ? r.status : worst, "ok");

  const runDate = sorted[0]?.run_date;

  return (
    <div className="space-y-4">
      {/* overall banner */}
      <div className={`rounded-2xl border px-5 py-3 flex items-center gap-3 ${STATUS_COLOR[overall]}`}>
        <span className="text-xl">{STATUS_ICON[overall]}</span>
        <div>
          <div className="font-semibold text-sm capitalize">{overall === "ok" ? "All systems healthy" : `System status: ${overall}`}</div>
          {runDate && <div className="text-xs opacity-70">Last run: {runDate}</div>}
        </div>
      </div>

      {/* component cards */}
      <div className="grid gap-3 sm:grid-cols-2">
        {sorted.map((row) => {
          const m = row.metrics ?? {};
          return (
            <div key={row.component} className={`rounded-2xl border p-4 space-y-2 ${STATUS_COLOR[row.status]}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-base mr-1.5">{STATUS_ICON[row.status]}</span>
                  <span className="font-semibold text-sm text-gray-100">
                    {COMPONENT_LABEL[row.component] ?? row.component}
                  </span>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide border ${STATUS_COLOR[row.status]}`}>
                  {row.status}
                </span>
              </div>
              <p className="text-xs leading-relaxed opacity-80">{row.detail}</p>
              {/* key metrics chips */}
              {Object.keys(m).length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {row.component === "stock_model" || row.component === "mf_model" ? (
                    <>
                      {m.oos_auc  != null && <Chip label="OOS AUC"  value={m.oos_auc.toFixed(3)} />}
                      {m.cv_auc   != null && <Chip label="CV AUC"   value={m.cv_auc.toFixed(3)} />}
                      {m.oos_samples != null && <Chip label="OOS n" value={m.oos_samples} />}
                      {m.trained_at  && <Chip label="Trained" value={m.trained_at} />}
                    </>
                  ) : row.component === "outcomes" ? (
                    <>
                      {m.hit_rate_pct      != null && <Chip label="Net hit rate"   value={`${m.hit_rate_pct}%`} />}
                      {m.gross_hit_rate_pct != null && <Chip label="Gross hit rate" value={`${m.gross_hit_rate_pct}%`} />}
                      {m.mean_ret != null && <Chip label="Mean ret" value={`${m.mean_ret > 0 ? "+" : ""}${m.mean_ret}%`} />}
                      {m.n        != null && <Chip label="n" value={m.n} />}
                    </>
                  ) : row.component === "freshness" ? (
                    <>
                      {m.latest   && <Chip label="Latest date" value={m.latest} />}
                      {m.age_days != null && <Chip label="Age" value={`${m.age_days}d`} />}
                    </>
                  ) : row.component === "mfapi_data" ? (
                    <>
                      {m.nav_count != null && <Chip label="NAV rows" value={m.nav_count} />}
                    </>
                  ) : row.component === "ic_drift" ? (
                    <>
                      {m.n_signals != null && <Chip label="Signals" value={m.n_signals} />}
                      {m.flipped?.length > 0 && <Chip label="Flipped" value={m.flipped.join(", ")} warn />}
                    </>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ label, value, warn }) {
  return (
    <div className={`rounded-lg px-2 py-0.5 text-[10px] ${warn ? "bg-yellow-900/30 text-yellow-300" : "bg-gray-800/60 text-gray-400"}`}>
      <span className="text-gray-600">{label}: </span>{value}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
      <p className="animate-pulse text-sm text-gray-400">Loading admin data…</p>
    </div>
  );
}
