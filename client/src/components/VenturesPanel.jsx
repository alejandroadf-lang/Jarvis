import { useCallback, useEffect, useState } from 'react';
import {
  fetchVentures,
  fetchLedger,
  greenlightVenture,
  approveTranche,
  denyTranche,
  killVenture,
  linkVentureRepo,
  enableVentureDeployment,
  disableVentureDeployment,
  linkVentureOutreach,
  enableVentureOutreach,
  disableVentureOutreach,
} from '../api/chat.js';

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

// Real code deployment is a scope the founder grants once (link a repo,
// then enable it), not a per-deploy approval — see finance/ventures.js's
// authorizeDeployment for why. This panel is that grant: linking a repo
// that already exists, an allowlist of paths the Engineering Lead can
// touch, and a weekly cap, plus a running log of every real commit made
// inside that scope.
function DeploymentScope({ venture, onLinkRepo, onEnable, onDisable, busy }) {
  const [showForm, setShowForm] = useState(false);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('main');
  const [allowedPaths, setAllowedPaths] = useState('');
  const [maxPerWeek, setMaxPerWeek] = useState('3');

  const repo = venture.repo;
  const inputClass =
    'w-full text-[11px] bg-black/30 border border-cyan-500/20 rounded px-1.5 py-0.5 text-cyan-100 placeholder:text-cyan-500/40';

  const submit = (e) => {
    e.preventDefault();
    onLinkRepo(venture.id, {
      owner: owner.trim(),
      name: name.trim(),
      branch: branch.trim() || 'main',
      allowedPaths: allowedPaths
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
      maxPerWeek: Number(maxPerWeek) || 3,
    });
    setShowForm(false);
  };

  return (
    <div className="mt-2 border border-purple-500/20 rounded p-2">
      <p className="text-[10px] uppercase tracking-wide text-purple-300/70">Real deployment scope</p>
      {repo ? (
        <>
          <p className="text-[11px] text-cyan-500/60 mt-1">
            {repo.owner}/{repo.name} ({repo.branch}) · paths: {repo.allowedPaths.join(', ') || 'none set'} · cap{' '}
            {repo.maxPerWeek}/week
          </p>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] ${repo.enabled ? 'text-emerald-400/80' : 'text-cyan-500/50'}`}>
              {repo.enabled
                ? 'Enabled — Engineering Lead can deploy within scope, including the unattended daily cycle'
                : 'Disabled'}
            </span>
            <button
              onClick={() => (repo.enabled ? onDisable(venture.id) : onEnable(venture.id))}
              disabled={busy}
              className="text-[11px] border border-purple-500/30 text-purple-300/80 hover:text-purple-200 disabled:opacity-40 rounded-full px-2 py-0.5"
            >
              {repo.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
          {venture.deployments?.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {[...venture.deployments]
                .slice(-5)
                .reverse()
                .map((d, i) => (
                  <li key={i} className="text-[10px] text-cyan-500/50">
                    {new Date(d.deployedAt).toLocaleString()} · {d.path} —{' '}
                    {d.commitUrl ? (
                      <a href={d.commitUrl} target="_blank" rel="noreferrer" className="underline hover:text-cyan-400/70">
                        {d.message || 'commit'}
                      </a>
                    ) : (
                      d.message || 'commit'
                    )}
                    {d.triggeredBy === 'daily_cycle' && (
                      <span className="text-amber-400/70"> · unattended daily cycle</span>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </>
      ) : showForm ? (
        <form onSubmit={submit} className="mt-1 space-y-1">
          <div className="flex gap-1">
            <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="repo owner" className={inputClass} />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="repo name" className={inputClass} />
          </div>
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branch (main)" className={inputClass} />
          <input
            value={allowedPaths}
            onChange={(e) => setAllowedPaths(e.target.value)}
            placeholder="allowed paths, comma separated"
            className={inputClass}
          />
          <input
            value={maxPerWeek}
            onChange={(e) => setMaxPerWeek(e.target.value)}
            type="number"
            min="1"
            placeholder="max deploys/week"
            className={inputClass}
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !owner.trim() || !name.trim()}
              className="text-[11px] bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-full px-3 py-1"
            >
              Link repo
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="text-[11px] text-cyan-500/60">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button onClick={() => setShowForm(true)} className="mt-1 text-[11px] text-purple-300/70 hover:text-purple-200">
          Link a repo to enable real deployment
        </button>
      )}
    </div>
  );
}

// Same scope-grant shape as DeploymentScope above, applied to real
// outbound email instead of a commit — an allowlist of recipients/domains
// and a weekly cap, set once and then enabled. See
// finance/ventures.js's authorizeOutreach for the enforcement.
function OutreachScope({ venture, onLinkOutreach, onEnable, onDisable, busy }) {
  const [showForm, setShowForm] = useState(false);
  const [allowedRecipients, setAllowedRecipients] = useState('');
  const [maxPerWeek, setMaxPerWeek] = useState('5');

  const outreach = venture.outreach;
  const inputClass =
    'w-full text-[11px] bg-black/30 border border-cyan-500/20 rounded px-1.5 py-0.5 text-cyan-100 placeholder:text-cyan-500/40';

  const submit = (e) => {
    e.preventDefault();
    onLinkOutreach(venture.id, {
      allowedRecipients: allowedRecipients
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
      maxPerWeek: Number(maxPerWeek) || 5,
    });
    setShowForm(false);
  };

  return (
    <div className="mt-2 border border-purple-500/20 rounded p-2">
      <p className="text-[10px] uppercase tracking-wide text-purple-300/70">Real outreach scope</p>
      {outreach ? (
        <>
          <p className="text-[11px] text-cyan-500/60 mt-1">
            allowed: {outreach.allowedRecipients.join(', ') || 'none set'} · cap {outreach.maxPerWeek}/week
          </p>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] ${outreach.enabled ? 'text-emerald-400/80' : 'text-cyan-500/50'}`}>
              {outreach.enabled
                ? 'Enabled — Sales & Commercial can email within scope, including the unattended daily cycle'
                : 'Disabled'}
            </span>
            <button
              onClick={() => (outreach.enabled ? onDisable(venture.id) : onEnable(venture.id))}
              disabled={busy}
              className="text-[11px] border border-purple-500/30 text-purple-300/80 hover:text-purple-200 disabled:opacity-40 rounded-full px-2 py-0.5"
            >
              {outreach.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
          {venture.sentEmails?.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {[...venture.sentEmails]
                .slice(-5)
                .reverse()
                .map((e, i) => (
                  <li key={i} className="text-[10px] text-cyan-500/50">
                    {new Date(e.sentAt).toLocaleString()} · to {e.to} — {e.subject || 'no subject'}
                    {e.triggeredBy === 'daily_cycle' && (
                      <span className="text-amber-400/70"> · unattended daily cycle</span>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </>
      ) : showForm ? (
        <form onSubmit={submit} className="mt-1 space-y-1">
          <input
            value={allowedRecipients}
            onChange={(e) => setAllowedRecipients(e.target.value)}
            placeholder="allowed recipients, comma separated (e.g. someone@acme.com, @acme.com)"
            className={inputClass}
          />
          <input
            value={maxPerWeek}
            onChange={(e) => setMaxPerWeek(e.target.value)}
            type="number"
            min="1"
            placeholder="max emails/week"
            className={inputClass}
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !allowedRecipients.trim()}
              className="text-[11px] bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-full px-3 py-1"
            >
              Set outreach scope
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="text-[11px] text-cyan-500/60">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button onClick={() => setShowForm(true)} className="mt-1 text-[11px] text-purple-300/70 hover:text-purple-200">
          Set an outreach scope to enable real customer email
        </button>
      )}
    </div>
  );
}

function VentureCard({
  venture,
  action,
  onApproveTranche,
  onDenyTranche,
  onKill,
  onLinkRepo,
  onEnableDeployment,
  onDisableDeployment,
  onLinkOutreach,
  onEnableOutreach,
  onDisableOutreach,
  busy,
}) {
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
      {onLinkRepo && (
        <DeploymentScope
          venture={venture}
          onLinkRepo={onLinkRepo}
          onEnable={onEnableDeployment}
          onDisable={onDisableDeployment}
          busy={busy}
        />
      )}
      {onLinkOutreach && (
        <OutreachScope
          venture={venture}
          onLinkOutreach={onLinkOutreach}
          onEnable={onEnableOutreach}
          onDisable={onDisableOutreach}
          busy={busy}
        />
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

  const handleLinkRepo = async (id, repoConfig) => {
    setBusyId(id);
    setError(null);
    try {
      await linkVentureRepo(id, repoConfig);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleEnableDeployment = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await enableVentureDeployment(id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDisableDeployment = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await disableVentureDeployment(id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleLinkOutreach = async (id, outreachConfig) => {
    setBusyId(id);
    setError(null);
    try {
      await linkVentureOutreach(id, outreachConfig);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleEnableOutreach = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await enableVentureOutreach(id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleDisableOutreach = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await disableVentureOutreach(id);
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
              onLinkRepo={handleLinkRepo}
              onEnableDeployment={handleEnableDeployment}
              onDisableDeployment={handleDisableDeployment}
              onLinkOutreach={handleLinkOutreach}
              onEnableOutreach={handleEnableOutreach}
              onDisableOutreach={handleDisableOutreach}
              busy={busyId === v.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
