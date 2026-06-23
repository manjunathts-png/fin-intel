import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import Layout from "./components/Layout";
import Mf from "./pages/Mf";
import Stocks from "./pages/Stocks";
import MfPicks from "./pages/MfPicks";
import MfRadarPage from "./pages/MfRadarPage";
import MfRiskPage from "./pages/MfRiskPage";
import MfCompoundersPage from "./pages/MfCompoundersPage";
import StockPicks from "./pages/StockPicks";
import EtfPicks from "./pages/EtfPicks";
import StockSectorPage from "./pages/StockSectorPage";
import StockAllPage from "./pages/StockAllPage";
import StockHotspotsPage from "./pages/StockHotspotsPage";
import Simulator from "./pages/Simulator";
import DeepDive from "./pages/DeepDive";
import PersonaAdvisor from "./pages/PersonaAdvisor";
import Admin from "./pages/Admin";
import Glossary from "./pages/Glossary";
import FiiTracker from "./pages/FiiTracker";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            {/* ── Mutual Funds section ──────────────────────────────── */}
            <Route path="/mf" element={<Mf />}>
              <Route index                  element={<Navigate to="picks"       replace />} />
              <Route path="picks"           element={<MfPicks />} />
              <Route path="radar"           element={<MfRadarPage />} />
              <Route path="risk"            element={<MfRiskPage />} />
              <Route path="compounders"     element={<MfCompoundersPage />} />
            </Route>

            {/* ── Stocks section ────────────────────────────────────── */}
            <Route path="/stocks" element={<Stocks />}>
              <Route index                  element={<Navigate to="picks"       replace />} />
              <Route path="picks"           element={<StockPicks />} />
              <Route path="radar"           element={<StockSectorPage />} />
              <Route path="all"             element={<StockAllPage />} />
              <Route path="hotspots"        element={<StockHotspotsPage />} />
            </Route>

            {/* ── Legacy redirect ───────────────────────────────────── */}
            <Route path="/picks"            element={<Navigate to="/mf/picks"   replace />} />

            {/* ── ETFs ──────────────────────────────────────────────── */}
            <Route path="/etf"              element={<EtfPicks />} />

            {/* ── Top-level pages ───────────────────────────────────── */}
            <Route path="/market"           element={<FiiTracker />} />
            <Route path="/simulator"        element={<Simulator />} />
            <Route path="/deep-dive"        element={<DeepDive />} />
            <Route path="/persona"          element={<PersonaAdvisor />} />
            <Route path="/admin"            element={<Admin />} />
            <Route path="/glossary"         element={<Glossary />} />

            {/* ── Catch-all ─────────────────────────────────────────── */}
            <Route path="*"                 element={<Navigate to="/mf/picks"   replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
