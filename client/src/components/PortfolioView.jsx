import { useEffect, useState } from 'react';
import { fetchPortfolio } from '../api/chat.js';

function StatTile({ label, value, tone = 'text-cyan-100' }) {
  return (
    <div className="border border-cyan-500/20 rounded-lg p-3">
      <p className="text-[11px] uppercase tracking-wide text-cyan-500/60">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${tone}`}>{value}</p>
    </div>
  );
}

const STATUS_STYLE = {
  proposed: 'text-amber-400/80 border-amber-500/30',
  active: 'text-emerald-400/80 border-emerald-500/30',
  killed: 'text-red-400/70 border-red-500/30',
};

function fmtMoney(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(0)}`;
}

export default function PortfolioView({ reloadKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchPortfolio()
      .then(setData)
      .catch((err) => setError(err.message));
  }, [reloadKey]);

  if (error) {
    return <p className="text-xs text-red-400 p-6">{error}</p>;
  }
  if (!data) {
    return <p className="text-xs text-cyan-500/50 p-6">Loading portfolio…</p>;
  }

  const { ventures, totals, treasury } = data;
  const order = { active: 0, proposed: 1, killed: 2 };
  const sorted = [...ventures].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-sm font-semibold uppercase tracking-wide text-cyan-300 mb-4">Portfolio</h1>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <StatTile label="Treasury" value={`${fmtMoney(treasury.balance)} / $${treasury.startingCapital}`} />
        <StatTile label="Allocated" value={fmtMoney(totals.allocated)} />
        <StatTile label="Revenue" value={fmtMoney(totals.revenue)} tone="text-emerald-300" />
        <StatTile label="Expenses" value={fmtMoney(totals.expense)} tone="text-red-300" />
        <StatTile label="Net" value={fmtMoney(totals.net)} tone={totals.net >= 0 ? 'text-emerald-300' : 'text-red-300'} />
      </div>

      {sorted.length === 0 ? (
        <p className="text-xs text-cyan-500/50">
          No ventures yet — propose one in Venture Studio and greenlight it to see it here.
        </p>
      ) : (
        <div className="overflow-x-auto border border-cyan-500/20 rounded-lg">
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="border-b border-cyan-500/20 text-cyan-500/60 uppercase tracking-wide text-[10px]">
                <th className="px-3 py-2">Venture</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Milestones</th>
                <th className="px-3 py-2 text-right">Allocated</th>
                <th className="px-3 py-2 text-right">Revenue</th>
                <th className="px-3 py-2 text-right">Expense</th>
                <th className="px-3 py-2 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((v) => (
                <tr key={v.id} className="border-b border-cyan-500/10 last:border-0 align-top">
                  <td className="px-3 py-2">
                    <p className="text-cyan-100">{v.title}</p>
                    <p className="text-cyan-500/50 mt-0.5">{v.oneLiner}</p>
                    {v.status === 'killed' && v.killReason && (
                      <p className="text-red-400/60 mt-0.5">Killed: {v.killReason}</p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`text-[10px] uppercase tracking-wide border rounded-full px-2 py-0.5 ${
                        STATUS_STYLE[v.status] || 'text-cyan-400/60 border-cyan-500/30'
                      }`}
                    >
                      {v.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-cyan-400/70">
                    {v.milestoneSummary.done}/{v.milestoneSummary.total} done
                    {v.milestoneSummary.missed > 0 && `, ${v.milestoneSummary.missed} missed`}
                  </td>
                  <td className="px-3 py-2 text-right text-cyan-100">{fmtMoney(v.financials.allocated)}</td>
                  <td className="px-3 py-2 text-right text-emerald-300">{fmtMoney(v.financials.revenue)}</td>
                  <td className="px-3 py-2 text-right text-red-300">{fmtMoney(v.financials.expense)}</td>
                  <td
                    className={`px-3 py-2 text-right ${
                      v.financials.net >= 0 ? 'text-emerald-300' : 'text-red-300'
                    }`}
                  >
                    {fmtMoney(v.financials.net)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
