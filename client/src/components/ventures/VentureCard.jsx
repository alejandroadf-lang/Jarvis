// One venture in the Ventures panel: its status, milestones, and the two
// scopes that let agents act for it for real (deploying code, emailing
// customers). Split out of VenturesPanel.jsx; every change goes back through
// the callbacks it is given, so this file fetches nothing itself.

import { useState } from 'react';

function StatusBadge({ status }) {
  const styles = {
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
  const [maxPerDay, setMaxPerDay] = useState('1');

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
      maxPerDay: Number(maxPerDay) || 1,
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
            {repo.maxPerDay || 1}/day, {repo.maxPerWeek}/week
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
          <div className="flex gap-1">
            <input
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
              type="number"
              min="1"
              placeholder="max/day"
              className={inputClass}
            />
            <input
              value={maxPerWeek}
              onChange={(e) => setMaxPerWeek(e.target.value)}
              type="number"
              min="1"
              placeholder="max/week"
              className={inputClass}
            />
          </div>
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
  const [maxPerDay, setMaxPerDay] = useState('1');

  const outreach = venture.outreach;
  // The latest note per contact — the panel is a glance at what Sales is
  // carrying into the next email, not the full note history.
  const contactNotes = Object.entries(venture.contactNotes || {}).flatMap(([email, notes]) =>
    notes.slice(-1).map((note) => ({ email, note }))
  );
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
      maxPerDay: Number(maxPerDay) || 1,
    });
    setShowForm(false);
  };

  return (
    <div className="mt-2 border border-purple-500/20 rounded p-2">
      <p className="text-[10px] uppercase tracking-wide text-purple-300/70">Real outreach scope</p>
      {outreach ? (
        <>
          <p className="text-[11px] text-cyan-500/60 mt-1">
            allowed: {outreach.allowedRecipients.join(', ') || 'none set'} · cap {outreach.maxPerDay || 1}/day,{' '}
            {outreach.maxPerWeek}/week
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
          {contactNotes.length > 0 && (
            <div className="mt-2 pt-2 border-t border-purple-500/20">
              <p className="text-[10px] uppercase tracking-wide text-purple-300/50">What Sales knows</p>
              <ul className="mt-1 space-y-0.5">
                {contactNotes.map(({ email, note }, i) => (
                  <li key={i} className="text-[10px] text-cyan-500/50">
                    <span className="text-cyan-500/70">{email}</span>: {note.note}
                  </li>
                ))}
              </ul>
            </div>
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
          <div className="flex gap-1">
            <input
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
              type="number"
              min="1"
              placeholder="max/day"
              className={inputClass}
            />
            <input
              value={maxPerWeek}
              onChange={(e) => setMaxPerWeek(e.target.value)}
              type="number"
              min="1"
              placeholder="max/week"
              className={inputClass}
            />
          </div>
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


export default function VentureCard({
  venture,
  action,
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
      <MilestoneList milestones={venture.milestones} />
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

