// Reusable page footer showing data sources + score methodology.
// Each page passes its own columns via the `sections` prop.

export default function PageFooter({ sections = [], note }) {
  return (
    <div className="mt-6 rounded-2xl border border-gray-800/60 bg-gray-900/40 p-4 space-y-3 text-[11px] text-gray-500">
      <div className="font-semibold text-gray-400 text-xs">📋 How this page works</div>

      <div className={`grid grid-cols-1 gap-3 ${sections.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
        {sections.map((s) => (
          <div key={s.title}>
            <div className="mb-1 font-semibold uppercase tracking-wider text-[10px] text-gray-600">{s.title}</div>
            <ul className="space-y-0.5">
              {s.items.map((item, i) => (
                <li key={i}>• {item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-gray-700 border-t border-gray-800/60 pt-2">
        {note ?? "Not financial advice. Past performance does not guarantee future returns. Signals are momentum-based and may not reflect fundamental deterioration."}
      </p>
    </div>
  );
}
