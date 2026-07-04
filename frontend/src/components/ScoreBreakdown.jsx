// "Why this score" — decomposes a pick's compositeScore from fields the
// pipeline already annotates on every stock. Mirrors the nightly build order
// (refresh-cache.js): signals+ML+regime → eodBaseScore → EMA smoothing →
// incumbent bonus → sector cap → (intraday re-blend during market hours).

const POS_FILL = "#16a34a"; // validated bar fills on gray-900 (see TrackRecord.jsx)
const NEG_FILL = "#ef4444";

function Row({ label, value, note, isTotal }) {
  if (value == null) return null;
  const width = Math.min(100, (Math.abs(value) / 100) * 100);
  return (
    <div className={`flex items-center gap-2 ${isTotal ? "border-t border-gray-800/60 pt-1.5 mt-1" : ""}`}>
      <div className={`w-44 shrink-0 text-[10px] ${isTotal ? "font-semibold text-gray-300" : "text-gray-500"}`}>
        {label}
        {note && <span className="ml-1 text-gray-600">{note}</span>}
      </div>
      <div className="h-2 flex-1 overflow-hidden rounded bg-gray-800/80">
        <div
          className="h-full rounded"
          style={{ width: `${width}%`, backgroundColor: value >= 0 ? POS_FILL : NEG_FILL }}
        />
      </div>
      <div className={`w-12 shrink-0 text-right text-[10px] tabular-nums ${isTotal ? "font-bold text-gray-200" : value >= 0 ? "text-green-400" : "text-red-400"}`}>
        {value >= 0 ? "+" : ""}{Math.round(value)}
      </div>
    </div>
  );
}

export default function ScoreBreakdown({ pick }) {
  if (!pick || pick.eodBaseScore == null) return null;

  const smoothing = pick.eodCompositeScore != null && pick.rawScore != null
    ? pick.eodCompositeScore - pick.rawScore
    : null;
  const incumbent = pick.incumbentBonus || null;
  const sectorCap = pick.sectorCapPenalty ? -pick.sectorCapPenalty : null;
  const eodFinal = (pick.eodCompositeScore ?? pick.eodBaseScore)
    + (pick.incumbentBonus ?? 0)
    - (pick.sectorCapPenalty ?? 0);
  const intraday = pick.intradayAsOf != null && pick.compositeScore != null
    ? pick.compositeScore - eodFinal
    : null;

  const regimeDock = (pick.regimePenalty ?? 0) + (pick.regimeOverextPenalty ?? 0);

  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        Score breakdown
      </div>
      <div className="space-y-1">
        <Row label="Today's signals (incl. ML & regime)" value={pick.eodBaseScore} />
        <Row label="Smoothing vs yesterday" note="(EMA 50/50)" value={smoothing} />
        <Row label="Incumbent bonus" note="(in yesterday's top 50)" value={incumbent} />
        <Row label="Sector concentration cap" value={sectorCap} />
        <Row label="Intraday re-score" note="(live signals)" value={intraday} />
        <Row label={`Composite score`} value={pick.compositeScore} isTotal />
      </div>

      {/* Components already inside the signal score — context, not addends */}
      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
        {pick.mlScore != null && (
          <span className="rounded border border-gray-700 px-1.5 py-0.5 text-gray-400" title={`LightGBM cross-sectional percentile, blended at weight ${pick.mlBlendWeight ?? 0}`}>
            ML {pick.mlScore}th pct{pick.mlBlendWeight ? ` · w=${pick.mlBlendWeight}` : " · not blended"}
          </span>
        )}
        {regimeDock > 0 && (
          <span className="rounded border border-red-800/40 bg-red-900/15 px-1.5 py-0.5 text-red-400" title="Regime dock applied to weak names (already inside today's signal score)">
            regime −{regimeDock}
          </span>
        )}
        {(pick.overextensionPenalty ?? 0) < 0 && (
          <span className="rounded border border-orange-800/40 bg-orange-900/15 px-1.5 py-0.5 text-orange-400" title="Overbought RSI / stretched vs 50DMA / recent spike — entry-timing dock inside the signal score">
            overextended {pick.overextensionPenalty}
          </span>
        )}
        {(pick.pullbackBonus ?? 0) > 0 && (
          <span className="rounded border border-green-800/40 bg-green-900/15 px-1.5 py-0.5 text-green-400" title="Confirmed uptrend bought on a dip — entry-timing bonus inside the signal score">
            pullback +{pick.pullbackBonus}
          </span>
        )}
        {(pick.liquidityPenalty ?? 0) < 0 && (
          <span className="rounded border border-yellow-800/40 bg-yellow-900/15 px-1.5 py-0.5 text-yellow-400" title="Thin average daily traded value — slippage risk">
            liquidity {pick.liquidityPenalty}
          </span>
        )}
      </div>
    </div>
  );
}
