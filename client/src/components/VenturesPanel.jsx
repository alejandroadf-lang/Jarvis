import { useCallback, useEffect, useState } from 'react';
import {
  fetchVentures,
  fetchLedger,
  killVenture,
  linkVentureRepo,
  enableVentureDeployment,
  disableVentureDeployment,
  linkVentureOutreach,
  enableVentureOutreach,
  disableVentureOutreach,
  fetchKillSwitch,
  haltRealActions,
  resumeRealActions,
  fetchSpend,
  fetchIntegrations,
  fetchWhatsAppActivity,
  fetchDailyPlan,
  approveDailyPlan,
  rejectDailyPlan,
} from '../api/chat.js';

function formatUsd(amount) {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

// One control that stops every venture at once. Deliberately the first thing
// in the panel and the loudest thing on screen when engaged: the whole point
// is that it's reachable without hunting through per-venture settings.
const INTEGRATION_LABELS = {
  access: 'Access (is this app locked?)',
  storage: 'Storage (does data survive a redeploy?)',
  anthropic: 'Claude',
  openrouter: 'OpenRouter (specialist agents)',
  openai: 'OpenAI (voice notes, fallback)',
  gemini: 'Gemini (fallback)',
  honcho: 'Honcho (founder memory)',
  email: 'Email',
  github: 'GitHub',
  workspace: 'Workspace (Obsidian / VS Code)',
  whatsapp: 'WhatsApp',
};

// Three states, not two. `ok === null` means "nothing to verify" — either the
// integration was never set up, or it's one that fails loudly at the point of
// use and needs no probe. Colouring that as a failure would nag about every
// feature the founder deliberately hasn't turned on.
function statusDot(entry) {
  if (entry.ok === true) return { color: 'bg-emerald-400', title: 'Working' };
  if (entry.ok === false) return { color: 'bg-red-400', title: 'Not working' };
  return { color: entry.configured ? 'bg-cyan-400/60' : 'bg-cyan-500/20', title: entry.configured ? 'Set' : 'Not set' };
}

function Integrations({ status, onRefresh, busy }) {
  const [open, setOpen] = useState(false);
  if (!status) return null;

  const broken = Object.values(status).filter((entry) => entry.ok === false).length;

  return (
    <div className="mb-4 border border-cyan-500/20 rounded-lg">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wide text-cyan-300"
      >
        <span>Integrations</span>
        <span className={broken ? 'text-red-400' : 'text-cyan-500/50'}>
          {broken > 0 ? `${broken} not working` : 'all good'} {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {Object.entries(status).map(([key, entry]) => {
            const dot = statusDot(entry);
            return (
              <div key={key} className="flex gap-2">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dot.color}`} title={dot.title} />
                <div className="min-w-0">
                  <p className="text-[11px] text-cyan-100/90">{INTEGRATION_LABELS[key] || key}</p>
                  <p className={`text-[11px] ${entry.ok === false ? 'text-red-400/80' : 'text-cyan-500/50'}`}>
                    {entry.detail}
                  </p>
                </div>
              </div>
            );
          })}
          <button
            onClick={onRefresh}
            disabled={busy}
            className="text-[11px] text-cyan-400/80 hover:text-cyan-300 disabled:opacity-40 underline"
          >
            {busy ? 'Checking…' : 'Re-check now'}
          </button>
        </div>
      )}
    </div>
  );
}

// Two grey ticks in WhatsApp prove Meta delivered the message to the business
// number and nothing whatsoever after that. This is the rest of the journey:
// whether Meta called the webhook, whether the signature checked out, whether
// the sender was allowlisted, and whether the team managed to answer.
const WHATSAPP_STAGE_TONE = {
  answered: 'text-emerald-400',
  bad_signature: 'text-red-400',
  not_allowlisted: 'text-amber-400',
  failed: 'text-red-400',
  unsupported_type: 'text-amber-400',
  duplicate: 'text-cyan-500/50',
};

function WhatsAppActivity({ activity, onRefresh, busy }) {
  const [open, setOpen] = useState(false);
  if (!activity) return null;

  const { events = [], receipts = {} } = activity;
  // Receipts are the tell that separates "Meta isn't calling us" from "Meta is
  // calling us but no message got through" — two very different fixes.
  const heard = events.length > 0 || receipts.count > 0;

  return (
    <div className="mb-4 border border-cyan-500/20 rounded-lg">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wide text-cyan-300"
      >
        <span>WhatsApp activity</span>
        <span className={heard ? 'text-cyan-500/50' : 'text-amber-400'}>
          {events.length ? `${events.length} message${events.length === 1 ? '' : 's'}` : heard ? 'receipts only' : 'nothing yet'}{' '}
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {!heard && (
            <p className="text-[11px] text-amber-400/90">
              Meta has never called this webhook. That points at the Meta dashboard rather than
              this app — check that the <span className="font-mono">messages</span> field is
              subscribed under WhatsApp → Configuration → Webhook fields.
            </p>
          )}

          {heard && events.length === 0 && (
            <p className="text-[11px] text-amber-400/90">
              Meta is calling the webhook ({receipts.count} status update
              {receipts.count === 1 ? '' : 's'}), but no actual message has arrived. The{' '}
              <span className="font-mono">messages</span> field is probably not subscribed.
            </p>
          )}

          {events.map((event, i) => (
            <div key={`${event.at}-${i}`} className="border-l border-cyan-500/20 pl-2">
              <p className={`text-[11px] ${WHATSAPP_STAGE_TONE[event.stage] || 'text-cyan-100/90'}`}>
                {event.summary}
              </p>
              <p className="text-[11px] text-cyan-500/50">
                {new Date(event.at).toLocaleString()}
                {event.from ? ` · ${event.from}` : ''}
              </p>
              {event.preview && <p className="text-[11px] text-cyan-100/60 truncate">"{event.preview}"</p>}
              {event.detail && <p className="text-[11px] text-red-400/80">{event.detail}</p>}
            </div>
          ))}

          <button
            onClick={onRefresh}
            disabled={busy}
            className="text-[11px] text-cyan-400/80 hover:text-cyan-300 disabled:opacity-40 underline"
          >
            {busy ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      )}
    </div>
  );
}

// The founder's one decision of the day. Deliberately the loudest thing in
// the panel when something is waiting: the team is stopped until it's
// answered, so burying it would cost a day of work rather than a scroll.
function DailyPlan({ state, onApprove, onReject, busy }) {
  const [reason, setReason] = useState('');
  if (!state?.required) return null;

  const plan = state.plan;

  if (!plan) {
    return (
      <div className="mb-4 border border-cyan-500/20 rounded-lg p-3">
        <p className="text-[11px] uppercase tracking-wide text-cyan-300">Today&apos;s plan</p>
        <p className="text-[11px] text-cyan-500/50 mt-1">
          Not submitted yet. Real actions are blocked until the team submits a plan and you approve it.
        </p>
      </div>
    );
  }

  const pending = plan.status === 'pending';

  return (
    <div
      className={`mb-4 rounded-lg p-3 border ${
        pending ? 'border-amber-500/50 bg-amber-950/20' : 'border-cyan-500/20'
      }`}
    >
      <p className={`text-[11px] uppercase tracking-wide ${pending ? 'text-amber-400 font-semibold' : 'text-cyan-300'}`}>
        Today&apos;s plan · {plan.status}
      </p>
      {plan.summary && <p className="text-[11px] text-cyan-100/90 mt-1">{plan.summary}</p>}

      <ul className="mt-2 space-y-1">
        {plan.items.map((item, i) => (
          <li key={i} className="text-[11px] text-cyan-100/80 border-l border-cyan-500/20 pl-2">
            <span className="font-mono text-cyan-300">{item.action}</span>
            {item.target ? <span className="text-cyan-500/70"> on {item.target}</span> : <span className="text-amber-400/70"> (any target)</span>}
            <br />
            <span className="text-cyan-500/60">{item.intent}</span>
          </li>
        ))}
      </ul>

      {pending && (
        <>
          <p className="text-[11px] text-amber-400/80 mt-2">
            Nothing runs until you decide. Approving covers exactly these — anything else is refused.
          </p>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional note or reason"
            className="mt-2 w-full bg-black/30 border border-cyan-500/20 rounded px-2 py-1 text-[11px] text-cyan-100"
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => onApprove(reason)}
              disabled={busy}
              className="text-[11px] px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-600 disabled:opacity-40 text-white"
            >
              Approve the day
            </button>
            <button
              onClick={() => onReject(reason)}
              disabled={busy}
              className="text-[11px] px-2 py-1 rounded border border-red-500/50 text-red-400 hover:bg-red-950/40 disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        </>
      )}

      {plan.note && !pending && <p className="text-[11px] text-cyan-500/60 mt-2">Your note: {plan.note}</p>}
    </div>
  );
}

function KillSwitch({ state, onHalt, onResume, busy }) {
  if (!state) return null;

  if (state.halted) {
    return (
      <div className="border border-red-500/50 bg-red-950/30 rounded-lg p-3 mb-4">
        <p className="text-[11px] uppercase tracking-wide text-red-400 font-semibold">All real actions halted</p>
        <p className="text-[11px] text-red-300/80 mt-1">{state.reason}</p>
        {state.changedAt && (
          <p className="text-[10px] text-red-300/50 mt-1">Since {new Date(state.changedAt).toLocaleString()}</p>
        )}
        {state.envLocked ? (
          <p className="text-[10px] text-red-300/60 mt-2">
            Locked by the server environment — unset REAL_ACTIONS_DISABLED and restart to resume.
          </p>
        ) : (
          <button
            onClick={onResume}
            disabled={busy}
            className="mt-2 text-xs border border-red-500/40 text-red-300 hover:text-red-200 disabled:opacity-40 rounded-full px-3 py-1"
          >
            Resume real actions
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={onHalt}
      disabled={busy}
      className="w-full mb-4 text-xs border border-red-500/30 text-red-400/80 hover:text-red-300 hover:border-red-500/50 disabled:opacity-40 rounded-lg px-3 py-2"
    >
      Halt all real actions
    </button>
  );
}

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

function VentureCard({
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

export default function VenturesPanel({ reloadKey }) {
  const [ledger, setLedger] = useState(null);
  const [ventures, setVentures] = useState([]);
  const [killSwitch, setKillSwitch] = useState(null);
  const [spend, setSpend] = useState(null);
  const [integrations, setIntegrations] = useState(null);
  const [checkingIntegrations, setCheckingIntegrations] = useState(false);
  const [dailyPlan, setDailyPlan] = useState(null);
  const [decidingPlan, setDecidingPlan] = useState(false);
  const [whatsapp, setWhatsapp] = useState(null);
  const [checkingWhatsapp, setCheckingWhatsapp] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    Promise.all([fetchLedger(), fetchVentures(), fetchKillSwitch(), fetchSpend()])
      .then(([l, v, k, s]) => {
        setLedger(l);
        setVentures(v);
        setKillSwitch(k);
        setSpend(s);
      })
      .catch((err) => setError(err.message));
    // Kept out of the Promise.all above on purpose: it makes real network
    // calls to two third parties, so it's slower than the rest and must not
    // hold the whole panel behind it — or fail it.
    fetchIntegrations()
      .then(setIntegrations)
      .catch(() => {});
    fetchWhatsAppActivity()
      .then(setWhatsapp)
      .catch(() => {});
    fetchDailyPlan()
      .then(setDailyPlan)
      .catch(() => {});
  }, []);

  const decidePlan = useCallback(async (decide, value) => {
    setDecidingPlan(true);
    try {
      await decide(value);
      setDailyPlan(await fetchDailyPlan());
    } catch (err) {
      setError(err.message);
    } finally {
      setDecidingPlan(false);
    }
  }, []);

  const refreshWhatsapp = useCallback(async () => {
    setCheckingWhatsapp(true);
    try {
      setWhatsapp(await fetchWhatsAppActivity());
    } catch {
      // Same as integrations: keep the last known state rather than blanking.
    } finally {
      setCheckingWhatsapp(false);
    }
  }, []);

  const recheckIntegrations = useCallback(async () => {
    setCheckingIntegrations(true);
    try {
      setIntegrations(await fetchIntegrations());
    } catch {
      // The panel keeps showing the last known state rather than blanking.
    } finally {
      setCheckingIntegrations(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

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

  const handleHalt = async () => {
    const reason = window.prompt('Why are you halting all real actions?');
    if (reason === null) return; // cancelled
    setBusyId('kill-switch');
    setError(null);
    try {
      setKillSwitch(await haltRealActions(reason));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleResume = async () => {
    setBusyId('kill-switch');
    setError(null);
    try {
      setKillSwitch(await resumeRealActions());
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
    return <p className="text-xs text-cyan-500/50 p-4">Loading…</p>;
  }

  const active = ventures.filter((v) => v.status === 'active');

  return (
    <div className="p-4 border-t border-cyan-500/20">
      <DailyPlan
        state={dailyPlan}
        onApprove={(note) => decidePlan(approveDailyPlan, note)}
        onReject={(reason) => decidePlan(rejectDailyPlan, reason)}
        busy={decidingPlan}
      />
      <Integrations status={integrations} onRefresh={recheckIntegrations} busy={checkingIntegrations} />
      <WhatsAppActivity activity={whatsapp} onRefresh={refreshWhatsapp} busy={checkingWhatsapp} />

      <KillSwitch
        state={killSwitch}
        onHalt={handleHalt}
        onResume={handleResume}
        busy={busyId === 'kill-switch'}
      />

      <h2 className="text-xs font-semibold uppercase tracking-wide text-cyan-300 mb-2">Performance</h2>
      <p className="text-2xl font-semibold text-cyan-100">
        {formatUsd(ledger.net)}
        <span className="text-xs text-cyan-500/50 font-normal"> net</span>
      </p>
      <p className="text-[11px] text-cyan-500/50 mt-0.5">
        {formatUsd(ledger.revenue)} earned · {formatUsd(ledger.expenses)} spent
      </p>
      {spend && (
        <p className={`text-[11px] mt-1 ${spend.overCap ? 'text-red-400/80' : 'text-cyan-500/50'}`}>
          Agent spend today: {formatUsd(spend.spentUsd)} / {formatUsd(spend.capUsd)} cap
          {spend.overCap && ' — model calls paused until the UTC day rolls over'}
        </p>
      )}

      {active.length === 0 && (
        <p className="text-[11px] text-cyan-500/50 mt-3">
          No ventures yet — brainstorm above until an idea clears the bar.
        </p>
      )}

      {active.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-[11px] uppercase tracking-wide text-cyan-500/60">Active</h3>
          {active.map((v) => (
            <VentureCard
              key={v.id}
              venture={v}
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
