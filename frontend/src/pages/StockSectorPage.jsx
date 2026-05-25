import { useOutletContext } from "react-router-dom";
import { SectorRadar } from "./StockRadar";
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
      '<span class="text-gray-400">NSE via Yahoo Finance</span> — daily OHLCV price data',
      '<span class="text-gray-400">NSE bhavcopy</span> — bulk &amp; block deal data',
      '<span class="text-gray-400">NSE F&amp;O feeds</span> — open interest data',
      "Refreshed nightly · prices lag by 1 trading day",
    ],
  },
  {
    title: "Composite Score (0–100)",
    items: [
      "15+ signals combined: momentum, RS vs Nifty,",
      "volume breakouts, Golden Cross, MACD, RSI,",
      "institutional activity (block/bulk, OI buildup),",
      "52-week high proximity",
      "Higher = more signals firing simultaneously",
    ],
  },
  {
    title: "Sector Metrics",
    items: [
      "<span class=\"text-gray-400\">Avg Score</span> — mean composite score of all stocks",
      "<span class=\"text-gray-400\">Strong</span> — stocks with score ≥ 60",
      "<span class=\"text-gray-400\">RS 1M / 3M</span> — stock return minus Nifty return",
      "<span class=\"text-gray-400\">52W Hi</span> — % of stocks near 52-week highs",
      "<span class=\"text-gray-400\">&gt; Nifty</span> — % outperforming Nifty 50",
    ],
  },
];

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
      <PageFooter sections={FOOTER} />
    </div>
  );
}
