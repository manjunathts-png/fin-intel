import { useOutletContext } from "react-router-dom";
import { SignalHotspots } from "./StockRadar";

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      <p className="animate-pulse text-sm text-gray-400">Loading…</p>
    </div>
  );
}

export default function StockHotspotsPage() {
  const { data, loading, error } = useOutletContext();

  if (loading) return <Spinner />;
  if (error)   return <p className="text-red-400 text-sm">Error: {error}</p>;
  if (!data)   return <p className="text-gray-500 text-sm">No stock data yet — run the signals refresh job.</p>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Signal Hotspots</h1>
        <p className="mt-0.5 text-xs text-gray-500">
          Sector × signal matrix — darker cells = more stocks firing that signal in that sector. Click any cell to drill down.
        </p>
      </div>
      <SignalHotspots picks={data.all ?? []} />
    </div>
  );
}
