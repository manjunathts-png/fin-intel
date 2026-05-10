import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import Layout from "./components/Layout";
import MfRadar from "./pages/MfRadar";
import StockRadar from "./pages/StockRadar";
import Picks from "./pages/Picks";
import Simulator from "./pages/Simulator";
import DeepDive from "./pages/DeepDive";
import Admin from "./pages/Admin";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/mf"        element={<MfRadar />} />
            <Route path="/stocks"    element={<StockRadar />} />
            <Route path="/picks"     element={<Picks />} />
            <Route path="/simulator" element={<Simulator />} />
            <Route path="/deep-dive" element={<DeepDive />} />
            <Route path="/admin"     element={<Admin />} />
            <Route path="*"          element={<Navigate to="/mf" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
