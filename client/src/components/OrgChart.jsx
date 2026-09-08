import { useEffect, useState } from 'react';
import { fetchOrgChart } from '../api/chat.js';

function Node({ agent, byId, depth }) {
  return (
    <div className={depth > 0 ? 'pl-3 border-l border-cyan-500/20 mt-1' : ''}>
      <div className="py-1">
        <p className="text-sm text-cyan-100 font-medium">{agent.title}</p>
        <p className="text-[11px] text-cyan-500/60 leading-snug">{agent.mission}</p>
      </div>
      {agent.reports.map((id) => byId[id] && <Node key={id} agent={byId[id]} byId={byId} depth={depth + 1} />)}
    </div>
  );
}

export default function OrgChart() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchOrgChart()
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (error) {
    return <p className="text-xs text-red-400 p-4">Couldn't load the org chart.</p>;
  }
  if (!data) {
    return <p className="text-xs text-cyan-500/50 p-4">Loading org chart…</p>;
  }

  const byId = Object.fromEntries(data.agents.map((a) => [a.id, a]));
  const root = byId[data.rootAgentId];
  if (!root) return null;

  return (
    <div className="h-full overflow-y-auto p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-cyan-300 mb-3">The Company</h2>
      <Node agent={root} byId={byId} depth={0} />
    </div>
  );
}
