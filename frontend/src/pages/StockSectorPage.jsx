import { useOutletContext } from "react-router-dom";
import { SectorRadar } from "./StockRadar";

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      <p className="animate-pulse text-sm text-gray-400">Loading…</p>
    </div>
  );
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function StockSectorPage() {
  const { data, builtAt, sectors, loading, error } = useOutletContext();

  if (loading) return <Spinner />;
  if (error)   return <p className="text-red-400 text-sm">Error: {error}</p>;
  if (!data)   return <p className="text-gray-500 text-sm">No stock data yet — run the signals refresh job.</p>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Stock Sector Radar</h1>
        <p className="mt-0.5 text-xs text-gray-500">
          {sectors.length} sectors · {data.all?.length ?? 0} stocks scanned
          {builtAt && ` · updated ${timeAgo(builtAt)}`}
          {" · "}
          <span className="text-gray-600">Default 4 columns — "Show all 7 columns" for the full view.</span>
        </p>
      </div>
      <SectorRadar sectors={sectors} />
    </div>
  );
}
