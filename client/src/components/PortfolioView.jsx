import { useEffect, useState } from 'react';
import { fetchPortfolio, fetchProfitShare } from '../api/chat.js';

function StatTile({ label, value, tone = 'text-cyan-100' }) {
  return (
    <div className="border border-cyan-500/20 rounded-lg p-3">
      <p className="text-[11px] uppercase tracking-wide text-cyan-500/60">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${tone}`}>{value}</p>
    </div>
  );
}

const STATUS_STYLE = {
  active: 'text-emerald-400/80 border-emerald-500/30',
  killed: 'text-red-400/70 border-red-500/30',
};

function fmtMoney(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(0)}`;
}

// Who earned what, and the events behind it. The audit surface: an agent
// only ever sees its own line, so this is the only place the whole
// distribution is visible and checkable.
function ProfitShare({ share }) {
  const [showEvents, setShowEvents] = useState(false);
  if (!share) return null;

  const { poolUsd, sharePct, agents, contributions, net } = share;

  return (
    <div className="mb-6 border border-cyan-500/20 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-cyan-300">Agent profit share</h2>
        <span className="text-[11px] text-cyan-500/50">{sharePct}% of net profit</span>
      </div>
      <p className="text-2xl font-semibold text-cyan-100">
        {fmtMoney(poolUsd)}
        <span className="text-xs text-cyan-500/50 font-normal"> pool</span>
      </p>

      {net <= 0 && (
        <p className="text-[11px] text-cyan-500/50 mt-1">
          Nothing to share until the company is profitable — contributions are still being tracked, so the
          pool distributes the moment net turns positive.
        </p>
      )}

      {agents.length === 0 ? (
        <p className="text-[11px] text-cyan-500/50 mt-2">
          No agent has done anything creditable yet. Credit is recorded when an action actually succeeds —
          shipping code, contacting a customer, starting or ending a venture.
        </p>
      ) : (
        <div className="mt-3 space-y-1">
          {agents.map((a) => (
            <div key={a.agentId} className="flex items-center gap-2 text-[11px]">
              <span className="w-48 shrink-0 truncate text-cyan-100/90">{a.agentId}</span>
              <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-cyan-500/60" style={{ width: `${a.sharePct}%` }} />
              </div>
              <span className="w-14 text-right text-cyan-500/60">{a.sharePct.toFixed(1)}%</span>
              <span className="w-16 text-right text-emerald-300 tabular-nums">{fmtMoney(a.earnedUsd)}</span>
            </div>
          ))}
        </div>
      )}

      {contributions?.length > 0 && (
        <>
          <button
            onClick={() => setShowEvents((v) => !v)}
            className="mt-3 text-[11px] text-cyan-400/80 hover:text-cyan-300 underline"
          >
            {showEvents ? 'Hide' : 'Show'} the {contributions.length} events behind these numbers
          </button>
          {showEvents && (
            <div className="mt-2 max-h-64 overflow-y-auto space-y-1">
              {contributions.map((c) => (
                <p key={c.id} className="text-[11px] text-cyan-500/60">
                  <span className="text-cyan-400/70">{c.at.slice(0, 10)}</span> · {c.agentId} · {c.kind}
                  {c.detail && ` — ${c.detail}`}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function PortfolioView({ reloadKey }) {
  const [data, setData] = useState(null);
  const [share, setShare] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchPortfolio()
      .then(setData)
      .catch((err) => setError(err.message));
    // Separate from the portfolio fetch: the share is additive, so a failure
    // here should cost the section, not the whole page.
    fetchProfitShare()
      .then(setShare)
      .catch(() => {});
  }, [reloadKey]);

  if (error) {
    return <p className="text-xs text-red-400 p-6">{error}</p>;
  }
  if (!data) {
    return <p className="text-xs text-cyan-500/50 p-6">Loading portfolio…</p>;
  }

  const { ventures, totals } = data;
  const order = { active: 0, killed: 1 };
  const sorted = [...ventures].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-sm font-semibold uppercase tracking-wide text-cyan-300 mb-4">Portfolio</h1>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatTile label="Revenue" value={fmtMoney(totals.revenue)} tone="text-emerald-300" />
        <StatTile label="Expenses" value={fmtMoney(totals.expense)} tone="text-red-300" />
        <StatTile label="Net" value={fmtMoney(totals.net)} tone={totals.net >= 0 ? 'text-emerald-300' : 'text-red-300'} />
      </div>

      <ProfitShare share={share} />

      {sorted.length === 0 ? (
        <p className="text-xs text-cyan-500/50">
          No ventures yet — brainstorm in Venture Studio until an idea clears the bar.
        </p>
      ) : (
        <div className="overflow-x-auto border border-cyan-500/20 rounded-lg">
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="border-b border-cyan-500/20 text-cyan-500/60 uppercase tracking-wide text-[10px]">
                <th className="px-3 py-2">Venture</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Milestones</th>
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
