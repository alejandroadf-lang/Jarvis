import { useEffect, useState } from 'react';
import { fetchVentures, fetchBuild } from '../api/chat.js';

// What the team is actually building, for a founder on a phone.
//
// The company could show which ventures existed and not what anyone was
// doing with them. GitHub answers "what code is there"; it says nothing
// about what is queued, what failed and why, or what the team has learned.
//
// Deliberately a list rather than a dashboard. This is read one-handed
// between other things, so it is ordered by what would make someone act:
// what is happening now, what landed, what broke, what was learned. Charts
// and tiles would look more impressive and answer none of those faster.

const TASK_STYLE = {
  done: { dot: 'bg-emerald-400', text: 'text-emerald-300/90', label: 'done' },
  running: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300/90', label: 'in progress' },
  queued: { dot: 'bg-cyan-500/40', text: 'text-cyan-300/70', label: 'queued' },
  failed: { dot: 'bg-red-400', text: 'text-red-300/90', label: 'failed' },
  cancelled: { dot: 'bg-white/20', text: 'text-cyan-500/50', label: 'cancelled' },
};

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`;
}

function Section({ title, count, children }) {
  return (
    <section className="mb-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-cyan-300 mb-2">
        {title}
        {count !== undefined && <span className="ml-2 text-cyan-500/50 font-normal">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <p className="text-[11px] text-cyan-500/50">{children}</p>;
}

function Tasks({ tasks }) {
  if (!tasks.length) {
    return <Empty>No work has been written down yet. The team queues it before starting a build.</Empty>;
  }
  return (
    <ol className="space-y-2">
      {tasks.map((t) => {
        const style = TASK_STYLE[t.status] || TASK_STYLE.queued;
        return (
          <li key={t.id} className="flex gap-2.5 items-start">
            <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${style.dot}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-cyan-100/90 break-words">{t.title}</p>
              <p className={`text-[11px] ${style.text}`}>
                {style.label}
                {t.attempts > 1 && ` · attempt ${t.attempts}`}
                {t.result && ` · ${t.result}`}
              </p>
              {/* The reason a task failed is the single most useful line on
                  this screen — it is what decides whether to retry or step in. */}
              {t.error && <p className="text-[11px] text-red-300/80 mt-0.5 break-words">{t.error}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Commits({ deployments, repo }) {
  if (!deployments.length) return <Empty>Nothing has been committed to this repo yet.</Empty>;
  return (
    <ul className="space-y-2">
      {deployments.map((d, i) => (
        <li key={`${d.commitSha || i}-${d.deployedAt}`} className="text-[11px]">
          <a
            href={d.commitUrl || (repo ? `https://github.com/${repo.owner}/${repo.name}` : '#')}
            target="_blank"
            rel="noreferrer"
            className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all"
          >
            {d.path}
          </a>
          <p className="text-cyan-500/60">
            {shortDate(d.deployedAt)}
            {d.agentId && ` · ${d.agentId}`}
            {d.triggeredBy === 'daily_cycle' && ' · unattended'}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Runs({ runs }) {
  if (!runs.length) {
    return <Empty>The checks have never run. Until they do, nobody knows whether this code works.</Empty>;
  }
  return (
    <ul className="space-y-2">
      {runs.map((r, i) => {
        const green = r.conclusion === 'success';
        return (
          <li key={`${r.runId || i}`} className="text-[11px] flex gap-2 items-baseline">
            <span className={green ? 'text-emerald-400' : 'text-red-400'}>{green ? '●' : '●'}</span>
            <div className="min-w-0">
              <a
                href={r.url || '#'}
                target="_blank"
                rel="noreferrer"
                className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
              >
                {r.workflow} — {r.conclusion || r.status}
              </a>
              <p className="text-cyan-500/60">{shortDate(r.startedAt)}</p>
              {(r.failures || []).map((f, j) => (
                <p key={j} className="text-red-300/80 break-words">
                  {f}
                </p>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function BuildView({ reloadKey }) {
  const [ventures, setVentures] = useState([]);
  const [selected, setSelected] = useState(null);
  const [build, setBuild] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchVentures()
      .then((list) => {
        const active = list.filter((v) => v.status === 'active');
        setVentures(active);
        setSelected((current) => current || active[0]?.id || null);
      })
      .catch((err) => setError(err.message));
  }, [reloadKey]);

  useEffect(() => {
    if (!selected) return undefined;
    let live = true;
    const load = () =>
      fetchBuild(selected)
        .then((data) => live && setBuild(data))
        .catch((err) => live && setError(err.message));
    load();
    // A build moves while it is being watched: a commit lands, a check turns
    // green. Without this the screen is a snapshot the founder has to keep
    // refreshing, which is exactly when they stop looking.
    const timer = setInterval(load, 20000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected, reloadKey]);

  if (error) return <div className="p-4 text-sm text-red-300/90">Couldn&apos;t load the build: {error}</div>;
  if (!ventures.length) {
    return (
      <div className="p-4 text-sm text-cyan-500/60">
        No active ventures. Ask the team to start one and it will appear here.
      </div>
    );
  }
  if (!build) return <div className="p-4 text-sm text-cyan-500/60">Loading…</div>;

  const { venture, tasks, deployments, runs, notes, spend, degradation } = build;
  const open = tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;
  const done = tasks.filter((t) => t.status === 'done').length;

  return (
    <div className="p-4 max-w-2xl mx-auto overflow-y-auto">
      {ventures.length > 1 && (
        <div className="flex gap-2 mb-4 flex-wrap">
          {ventures.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                setBuild(null);
                setSelected(v.id);
              }}
              className={`px-2.5 py-1 rounded text-[11px] ${
                v.id === selected ? 'bg-cyan-600 text-white' : 'text-cyan-400/80 hover:text-cyan-300'
              }`}
            >
              {v.title}
            </button>
          ))}
        </div>
      )}

      <h1 className="text-lg font-semibold text-cyan-100">{venture.title}</h1>
      <p className="text-[11px] text-cyan-500/60 mb-1">
        {venture.repo ? (
          <a
            href={`https://github.com/${venture.repo.owner}/${venture.repo.name}`}
            target="_blank"
            rel="noreferrer"
            className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
          >
            {venture.repo.owner}/{venture.repo.name}
          </a>
        ) : (
          'No repo linked — the team cannot ship anything until one is.'
        )}
        {venture.repo && !venture.repo.enabled && ' · deployments OFF'}
      </p>
      <p className="text-[11px] text-cyan-500/60 mb-5">
        {done} done · {open} outstanding · ${spend.spentUsd.toFixed(2)} of ${spend.capUsd.toFixed(2)} today
      </p>

      {/* Degradation is not build news, but it is the thing most likely to be
          quietly costing money while this screen is open. */}
      {degradation.count > 0 && (
        <p className="text-[11px] text-amber-300/90 mb-5 border border-amber-500/25 rounded p-2">
          {degradation.count} agent turn{degradation.count === 1 ? '' : 's'} ran on a fallback model today
          {degradation.extraUsd > 0 && ` (about $${degradation.extraUsd.toFixed(2)} more than intended)`}.
        </p>
      )}

      <Section title="Work" count={`${done}/${tasks.length}`}>
        <Tasks tasks={tasks} />
      </Section>

      <Section title="Commits" count={deployments.length || undefined}>
        <Commits deployments={deployments} repo={venture.repo} />
      </Section>

      <Section title="Checks" count={runs.length || undefined}>
        <Runs runs={runs} />
      </Section>

      <Section title="What the team learned" count={notes.length || undefined}>
        {notes.length ? (
          <ul className="space-y-2">
            {notes.map((n, i) => (
              <li key={i} className="text-[11px]">
                <p className="text-cyan-100/80 break-words">{n.note}</p>
                <p className="text-cyan-500/50">
                  {shortDate(n.at)}
                  {n.agentId && ` · ${n.agentId}`}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing recorded yet.</Empty>
        )}
      </Section>
    </div>
  );
}
