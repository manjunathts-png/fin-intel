import { useOutletContext } from "react-router-dom";
import { Compounders } from "./MfRadar";

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      <p className="animate-pulse text-sm text-gray-400">Loading…</p>
    </div>
  );
}

export default function MfCompoundersPage() {
  const { data, loading, error } = useOutletContext();

  if (loading) return <Spinner />;
  if (error)   return <p className="text-red-400 text-sm">Error: {error}</p>;
  if (!data)   return <p className="text-gray-500 text-sm">No MF data yet — run the refresh job.</p>;

  return <Compounders categories={data.categories} />;
}
