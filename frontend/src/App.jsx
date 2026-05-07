import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import Layout from "./components/Layout";
import MfRadar from "./pages/MfRadar";
import StockRadar from "./pages/StockRadar";
import Picks from "./pages/Picks";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/mf"     element={<MfRadar />} />
            <Route path="/stocks" element={<StockRadar />} />
            <Route path="/picks"  element={<Picks />} />
            <Route path="*"       element={<Navigate to="/mf" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
