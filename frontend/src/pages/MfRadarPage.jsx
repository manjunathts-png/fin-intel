import { useOutletContext } from "react-router-dom";
import { CategoryRadar } from "./MfRadar";
import PageFooter from "../components/PageFooter";

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

const FOOTER = [
  {
    title: "Data Sources",
    items: [
      '<span class="text-gray-400">AMFI NAVAll.txt</span> — fund names &amp; scheme codes',
      '<span class="text-gray-400">mfapi.in</span> — daily NAV history per scheme',
      "Refreshed nightly · NAV lags by 1 trading day",
    ],
  },
  {
    title: "Return Windows",
    items: [
      "1W / 1M / 3M / 6M / 1Y — raw (not annualised)",
      "3Y / 5Y / 10Y CAGR — compound annual growth rate",
      "Colour scale: green ≥ threshold · red below · grey = no data",
    ],
  },
  {
    title: "Risk Metrics",
    items: [
      "<span class=\"text-gray-400\">Sharpe</span> — excess return ÷ volatility (risk-free = 7%)",
      "<span class=\"text-gray-400\">Max DD</span> — worst peak-to-trough over 5 years",
      "<span class=\"text-gray-400\">Consistency</span> — % of 12M windows ≥ 12% CAGR",
      "<span class=\"text-gray-400\">α 5Y</span> — fund CAGR minus benchmark CAGR",
      "<span class=\"text-gray-400\">Z-score</span> — this week vs trailing 90-day avg",
    ],
  },
];

export default function MfRadarPage() {
  const { data, builtAt, loading, error } = useOutletContext();

  if (loading) return <Spinner />;
  if (error)   return <p className="text-red-400 text-sm">Error: {error}</p>;
  if (!data)   return <p className="text-gray-500 text-sm">No MF data yet — run the refresh job.</p>;

  const fundCount = data.categories.reduce((s, c) => s + c.fundCount, 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">MF Category Radar</h1>
        <p className="mt-0.5 text-xs text-gray-500">
          {fundCount} funds · {data.categories.length} categories
          {builtAt && ` · updated ${timeAgo(builtAt)}`}
          {" · "}
          <span className="text-gray-600">Default view shows 5 key columns — click "Show all 12 metrics" for the full heatmap.</span>
        </p>
      </div>
      <CategoryRadar categories={data.categories} />
      {data.warnings?.length > 0 && (
        <details className="text-xs text-gray-600">
          <summary className="cursor-pointer hover:text-gray-400">{data.warnings.length} warning(s)</summary>
          <ul className="mt-2 list-disc pl-5">
            {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </details>
      )}
      <PageFooter sections={FOOTER} />
    </div>
  );
}
