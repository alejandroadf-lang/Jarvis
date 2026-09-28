// The founder's controls at the top of the Ventures panel: what is connected,
// what WhatsApp has seen, today's plan waiting for a decision, and the switch
// that stops everything. Split out of VenturesPanel.jsx, which renders them;
// each takes its data and callbacks as props and fetches nothing itself.

import { useState } from 'react';

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
  circadian: 'Circadian (jet lag app at /circadian)',
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


export function Integrations({ status, onRefresh, busy }) {
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

export function WhatsAppActivity({ activity, onRefresh, busy }) {
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
export function DailyPlan({ state, onApprove, onReject, busy }) {
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


// One control that stops every venture at once. Deliberately the first thing
// in the panel and the loudest thing on screen when engaged: the whole point
// is that it's reachable without hunting through per-venture settings.
export function KillSwitch({ state, onHalt, onResume, busy }) {
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

