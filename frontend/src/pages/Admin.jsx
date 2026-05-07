import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";

const ADMIN_EMAIL = "manjunathts@gmail.com";

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

export default function Admin() {
  const { user } = useAuth();
  const [profiles, setProfiles] = useState([]);
  const [events,   setEvents]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [tab,      setTab]      = useState("users");

  if (user && user.email !== ADMIN_EMAIL) return <Navigate to="/mf" replace />;

  useEffect(() => {
    async function load() {
      const [{ data: p }, { data: e }] = await Promise.all([
        supabase.from("profiles").select("*").order("created_at", { ascending: false }),
        supabase.from("user_events").select("*").order("created_at", { ascending: false }).limit(500),
      ]);
      setProfiles(p ?? []);
      setEvents(e ?? []);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <Spinner />;

  // Derived stats
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const activeToday = new Set(
    events.filter((e) => new Date(e.created_at) >= today).map((e) => e.user_id)
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
        <StatCard label="Events (500)"   value={events.length} sub="last 500 loaded" />
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
        {["users", "activity"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition border-b-2 -mb-px ${
              tab === t
                ? "border-blue-500 text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {t === "users" ? `Users (${profiles.length})` : `Activity (${events.length})`}
          </button>
        ))}
      </div>

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

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
      <p className="animate-pulse text-sm text-gray-400">Loading admin data…</p>
    </div>
  );
}
