import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { trackEvent } from "../lib/analytics";

const ADMIN_EMAIL = "manjunathts@gmail.com";

const tabs = [
  { to: "/mf",        label: "Mutual Funds", icon: "📊" },
  { to: "/stocks",    label: "Stocks",       icon: "📈" },
  { to: "/simulator", label: "Simulator",    icon: "🧮" },
  { to: "/deep-dive", label: "Deep Dive",    icon: "🔍" },
  { to: "/persona",   label: "Persona",      icon: "🧭" },
];

export default function Layout() {
  const { user, loading, login, logout } = useAuth();
  const location = useLocation();

  useEffect(() => {
    if (user) trackEvent(user, "page_view", location.pathname);
  }, [location.pathname, user]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-gray-950 px-6 text-white">
        <div className="text-center">
          <div className="mb-3 text-5xl">💹</div>
          <h1 className="text-3xl font-bold tracking-tight">Fin Intel</h1>
          <p className="mt-2 text-gray-400">MF &amp; Stock momentum signals — India</p>
        </div>
        <button
          onClick={login}
          className="flex items-center gap-3 rounded-2xl bg-white px-7 py-3.5 font-semibold text-gray-900 shadow-lg transition active:scale-95"
        >
          <GoogleIcon />
          Continue with Google
        </button>
        <p className="max-w-xs text-center text-xs text-gray-600">
          Momentum signals based on AMFI NAV data and NSE price history.
          Not financial advice.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Desktop top nav */}
      <nav className="hidden md:block sticky top-0 z-40 border-b border-gray-800 bg-gray-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <span className="font-bold tracking-tight">💹 Fin Intel</span>
            <div className="flex gap-1">
              {tabs.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  className={({ isActive }) =>
                    `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      isActive ? "bg-gray-700 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white"
                    }`
                  }
                >
                  {t.icon} {t.label}
                </NavLink>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {user.user_metadata?.avatar_url && (
              <img
                src={user.user_metadata.avatar_url}
                alt=""
                className="h-7 w-7 rounded-full"
                referrerPolicy="no-referrer"
              />
            )}
            <span className="hidden text-sm text-gray-400 lg:block">
              {user.user_metadata?.full_name || user.email}
            </span>
            {user.email === ADMIN_EMAIL && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    isActive ? "bg-purple-700 text-white" : "bg-gray-800 text-purple-400 hover:bg-purple-900/50"
                  }`
                }
              >
                ⚙ Admin
              </NavLink>
            )}
            <button
              onClick={logout}
              className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-700"
            >
              Logout
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile top bar */}
      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-gray-800 bg-gray-950/95 px-4 py-3 backdrop-blur md:hidden">
        <span className="font-bold text-sm">💹 Fin Intel</span>
        <button
          onClick={logout}
          className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-400"
        >
          Logout
        </button>
      </div>

      {/* Page content */}
      <main className="mx-auto max-w-screen-2xl px-4 pb-28 pt-5 md:pb-12 md:px-6">
        <Outlet />
      </main>

      {/* Mobile bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-800 bg-gray-950 md:hidden">
        <div className="flex items-stretch">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center justify-center gap-0.5 py-3 text-[11px] font-medium transition ${
                  isActive ? "text-blue-400" : "text-gray-500"
                }`
              }
            >
              <span className="text-xl leading-none">{t.icon}</span>
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}
