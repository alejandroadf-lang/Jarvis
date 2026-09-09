import { useCallback, useEffect, useState } from 'react';
import { fetchVentures, fetchLedger, greenlightVenture, approveTranche, denyTranche, killVenture } from '../api/chat.js';

function StatusBadge({ status }) {
  const styles = {
    proposed: 'text-amber-400/80 border-amber-500/30',
    active: 'text-emerald-400/80 border-emerald-500/30',
    killed: 'text-red-400/70 border-red-500/30',
  };
  return (
    <span
      className={`text-[10px] uppercase tracking-wide border rounded-full px-2 py-0.5 ${
        styles[status] || 'text-cyan-400/60 border-cyan-500/30'
      }`}
    >
      {status}
    </span>
  );
}

function MilestoneList({ milestones }) {
  if (!milestones?.length) return null;
  const styles = {
    done: 'text-emerald-400/70',
    missed: 'text-red-400/60 line-through',
    pending: 'text-cyan-500/50',
  };
  return (
    <ul className="mt-1 space-y-0.5">
      {milestones.map((m, i) => (
        <li key={i} className={`text-[11px] ${styles[m.status] || 'text-cyan-500/50'}`}>
          {m.title} · {m.status}
        </li>
      ))}
    </ul>
  );
}

function VentureCard({ venture, action, onApproveTranche, onDenyTranche, onKill, busy }) {
  return (
    <div className="border border-cyan-500/20 rounded-lg p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-cyan-100">{venture.title}</p>
        <StatusBadge status={venture.status} />
      </div>
      <p className="text-[11px] text-cyan-500/60 mt-0.5">{venture.oneLiner}</p>
      {venture.marketSize && (
        <p className="text-[11px] text-cyan-500/50 mt-1">
          <span className="text-cyan-500/70">Market:</span> {venture.marketSize}
        </p>
      )}
      {venture.pathToMillions && (
        <p className="text-[11px] text-cyan-500/50 mt-1">
          <span className="text-cyan-500/70">Path to $1M+:</span> {venture.pathToMillions}
        </p>
      )}
      <p className="text-[11px] text-cyan-400/70 mt-1">
        {venture.status === 'active' ? 'Funded so far' : 'Asking'} ${venture.budgetRequested}
      </p>
      <MilestoneList milestones={venture.milestones} />
      {venture.pendingTranche && (
        <div className="mt-2 border border-amber-500/30 rounded p-2 space-y-1">
          <p className="text-[11px] text-amber-400/80">
            Tranche requested: ${venture.pendingTranche.amount} — {venture.pendingTranche.description}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => onApproveTranche(venture.id)}
              disabled={busy}
              className="text-xs bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white rounded-full px-3 py-1"
            >
              {busy ? 'Approving…' : 'Approve tranche'}
            </button>
            <button
              onClick={() => onDenyTranche(venture.id)}
              disabled={busy}
              className="text-xs border border-cyan-500/30 text-cyan-400/80 hover:text-cyan-300 disabled:opacity-40 rounded-full px-3 py-1"
            >
              Deny
            </button>
          </div>
        </div>
      )}
      {onKill && (
        <button
          onClick={() => onKill(venture.id)}
          disabled={busy}
          className="mt-2 text-[11px] text-red-400/60 hover:text-red-400 disabled:opacity-40"
        >
          Kill venture
        </button>
      )}
      {action}
    </div>
  );
}

export default function VenturesPanel({ sessionId, reloadKey, onGreenlit }) {
  const [ledger, setLedger] = useState(null);
  const [ventures, setVentures] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    Promise.all([fetchLedger(), fetchVentures()])
      .then(([l, v]) => {
        setLedger(l);
        setVentures(v);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const handleGreenlight = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      const result = await greenlightVenture(id, sessionId);
      load();
      onGreenlit?.(result);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleApproveTranche = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      const result = await approveTranche(id, sessionId);
      load();
      onGreenlit?.(result);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDenyTranche = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await denyTranche(id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleKill = async (id) => {
    const reason = window.prompt('Why is this venture being killed?');
    if (reason === null) return; // cancelled
    setBusyId(id);
    setError(null);
    try {
      await killVenture(id, reason);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (error) {
    return <p className="text-xs text-red-400 p-4">{error}</p>;
  }
  if (!ledger) {
    return <p className="text-xs text-cyan-500/50 p-4">Loading treasury…</p>;
  }

  const proposed = ventures.filter((v) => v.status === 'proposed');
  const active = ventures.filter((v) => v.status === 'active');

  return (
    <div className="p-4 border-t border-cyan-500/20">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-cyan-300 mb-2">Treasury</h2>
      <p className="text-2xl font-semibold text-cyan-100">
        ${ledger.balance.toFixed(0)}
        <span className="text-xs text-cyan-500/50 font-normal"> / ${ledger.startingCapital} seed</span>
      </p>

      {proposed.length === 0 && active.length === 0 && (
        <p className="text-[11px] text-cyan-500/50 mt-3">
          No ventures yet — brainstorm above until an idea is worth proposing.
        </p>
      )}

      {proposed.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-[11px] uppercase tracking-wide text-cyan-500/60">Proposed</h3>
          {proposed.map((v) => (
            <VentureCard
              key={v.id}
              venture={v}
              action={
                <button
                  onClick={() => handleGreenlight(v.id)}
                  disabled={busyId === v.id}
                  className="mt-2 text-xs bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white rounded-full px-3 py-1"
                >
                  {busyId === v.id ? 'Greenlighting…' : 'Greenlight → push to company'}
                </button>
              }
            />
          ))}
        </div>
      )}

      {active.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-[11px] uppercase tracking-wide text-cyan-500/60">Active</h3>
          {active.map((v) => (
            <VentureCard
              key={v.id}
              venture={v}
              onApproveTranche={handleApproveTranche}
              onDenyTranche={handleDenyTranche}
              onKill={handleKill}
              busy={busyId === v.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
