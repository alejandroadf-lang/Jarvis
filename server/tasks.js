// Work that outlives the turn that thought of it.
//
// This exists because of a specific, ordinary failure. The Engineering Lead
// was asked to ship a first commit — engine, tests, auth, rate limiting,
// docs, Dockerfile, CI — decided on all seven files, ran out of output
// tokens before writing any of them, and the turn ended. Zero files landed.
// More importantly, *nothing recorded that seven units of work existed*.
// Nobody would retry them. The only reason the founder found out at all is
// that the CTO happened to write an honest paragraph about it.
//
// That is the difference between a company that can hold a multi-step build
// and one that can only hold a conversation. A delegation today lives
// entirely inside one runAgent call: if the turn is cut short by the token
// ceiling, the two-minute deadline, a provider outage or a restart, the
// intent dies with it and leaves no trace.
//
// So work gets written down before it is attempted. An agent breaks a job
// into tasks, each task is claimed, attempted, and then either completed or
// failed with the reason kept. A turn that dies mid-way loses one task, not
// the plan. The next turn picks up where this one stopped, because the queue
// is in a file rather than in a context window.
//
// Deliberately the same shape as deepDives.js, which already proved the
// pattern on questions — claim, run, complete or fail, with the failure kept
// rather than swallowed. This applies it to work.
//
// What it is NOT: an approval mechanism. Queueing a task grants nothing.
// Every real action it leads to still passes the scope model, the approved
// plan, the rate limits and the kill switch, exactly as if the agent had
// decided to do it in conversation. A queue an agent can use to escape those
// would be a queue that dissolves them.

import { readJson, writeJson } from './store.js';

const FILE = 'tasks.json';
const MAX_KEPT = 300;

export const TASK_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// A task that has been attempted this many times and still fails is not
// going to start working on the next identical attempt. Retrying forever
// burns the spend cap on a loop nobody is watching.
const MAX_ATTEMPTS = 3;

function load() {
  const data = readJson(FILE, { tasks: [] });
  if (!Array.isArray(data.tasks)) data.tasks = [];
  return data;
}

function save(data) {
  // Finished work is history; the queue is what matters. Trimmed from the
  // front, and only ever among finished tasks — dropping a queued one to
  // make room would silently lose the very thing this file exists to keep.
  if (data.tasks.length > MAX_KEPT) {
    const open = data.tasks.filter((t) => t.status === TASK_STATUS.QUEUED || t.status === TASK_STATUS.RUNNING);
    const finished = data.tasks.filter((t) => t.status !== TASK_STATUS.QUEUED && t.status !== TASK_STATUS.RUNNING);
    data.tasks = [...finished.slice(-(MAX_KEPT - open.length)), ...open];
  }
  writeJson(FILE, data);
}

function find(data, id) {
  const task = data.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`No task with id "${id}".`);
  return task;
}

/**
 * Writes down a piece of work before anyone attempts it.
 *
 * @param {{ventureId: string, title: string, detail?: string, order?: number, queuedBy?: string}} input
 */
export function enqueueTask({ ventureId, title, detail, order, queuedBy }) {
  if (!ventureId) throw new Error('A task needs a ventureId — work belongs to a venture.');
  if (!title || !String(title).trim()) throw new Error('A task needs a title saying what it is.');

  const data = load();
  const task = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ventureId: String(ventureId),
    title: String(title).trim(),
    detail: detail ? String(detail) : null,
    // Explicit sequencing, because build work usually has an order and
    // "whatever came first" is not it — tests before CI, engine before tests.
    order: Number.isFinite(Number(order)) ? Number(order) : data.tasks.length,
    status: TASK_STATUS.QUEUED,
    attempts: 0,
    queuedBy: queuedBy || null,
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };
  data.tasks.push(task);
  save(data);
  return task;
}

/** Queue several at once, keeping the order they were given in. */
export function enqueueTasks(ventureId, items, queuedBy) {
  return items.map((item, i) =>
    enqueueTask({
      ventureId,
      title: typeof item === 'string' ? item : item.title,
      detail: typeof item === 'string' ? null : item.detail,
      order: i,
      queuedBy,
    })
  );
}

/** The next thing to do for a venture, or null. Never hands back running work. */
export function nextTask(ventureId) {
  const open = load()
    .tasks.filter((t) => t.status === TASK_STATUS.QUEUED && (!ventureId || t.ventureId === ventureId))
    .sort((a, b) => a.order - b.order || a.queuedAt.localeCompare(b.queuedAt));
  return open[0] || null;
}

/**
 * Claims a task. Attempts are counted here rather than on completion,
 * because the failure this guards against is a turn that dies without ever
 * reporting anything — which is precisely the case that would otherwise
 * leave the count at zero forever.
 */
export function startTask(id) {
  const data = load();
  const task = find(data, id);
  if (task.status === TASK_STATUS.RUNNING) throw new Error(`Task "${task.title}" is already running.`);
  if (task.status === TASK_STATUS.DONE) throw new Error(`Task "${task.title}" is already done.`);
  task.status = TASK_STATUS.RUNNING;
  task.attempts += 1;
  task.startedAt = new Date().toISOString();
  save(data);
  return task;
}

export function completeTask(id, result) {
  const data = load();
  const task = find(data, id);
  task.status = TASK_STATUS.DONE;
  task.result = result ? String(result) : null;
  task.finishedAt = new Date().toISOString();
  task.error = null;
  save(data);
  return task;
}

/**
 * Records a failure and decides whether it is worth another go.
 *
 * A task back in the queue is the whole point: the run that died mid-way
 * costs one task, not the plan. A task that has failed MAX_ATTEMPTS times
 * stays failed, because the next identical attempt will not go differently
 * and the loop would spend real money discovering that.
 */
export function failTask(id, error) {
  const data = load();
  const task = find(data, id);
  task.error = error ? String(error) : 'Unknown failure.';
  task.finishedAt = new Date().toISOString();
  task.status = task.attempts >= MAX_ATTEMPTS ? TASK_STATUS.FAILED : TASK_STATUS.QUEUED;
  save(data);
  return task;
}

export function cancelTask(id, reason) {
  const data = load();
  const task = find(data, id);
  task.status = TASK_STATUS.CANCELLED;
  task.error = reason ? String(reason) : null;
  task.finishedAt = new Date().toISOString();
  save(data);
  return task;
}

/**
 * Work claimed but never finished — the signature of a turn that died.
 *
 * Nothing releases a claim automatically on a timer: a task genuinely in
 * flight and a task orphaned by a crash look identical from here, and
 * guessing wrong means two agents doing the same work. This reports them so
 * a person (or the next cycle) can decide.
 */
export function stalledTasks(olderThanMs = 30 * 60 * 1000) {
  const cutoff = Date.now() - olderThanMs;
  return load().tasks.filter(
    (t) => t.status === TASK_STATUS.RUNNING && t.startedAt && Date.parse(t.startedAt) < cutoff
  );
}

export function releaseTask(id) {
  const data = load();
  const task = find(data, id);
  if (task.status !== TASK_STATUS.RUNNING) throw new Error(`Task "${task.title}" is not running.`);
  task.status = TASK_STATUS.QUEUED;
  task.startedAt = null;
  save(data);
  return task;
}

export function listTasks({ ventureId, status, limit = 50 } = {}) {
  return load()
    .tasks.filter((t) => (!ventureId || t.ventureId === ventureId) && (!status || t.status === status))
    .sort((a, b) => a.order - b.order || a.queuedAt.localeCompare(b.queuedAt))
    .slice(0, limit);
}

export function getTask(id) {
  return load().tasks.find((t) => t.id === id) || null;
}

export function openCount(ventureId) {
  return load().tasks.filter(
    (t) => (!ventureId || t.ventureId === ventureId) && (t.status === TASK_STATUS.QUEUED || t.status === TASK_STATUS.RUNNING)
  ).length;
}

/**
 * The outstanding work, for the agent context.
 *
 * Empty when there is none, rather than "no tasks" — this is appended to
 * every prompt, and a line saying nothing is outstanding on every single
 * turn is noise that makes the turns with real work in them harder to see.
 */
export function describeTasksForAgents(ventureId) {
  const open = listTasks({ ventureId }).filter(
    (t) => t.status === TASK_STATUS.QUEUED || t.status === TASK_STATUS.RUNNING
  );
  if (!open.length) return '';

  const lines = open.map((t) => {
    const state = t.status === TASK_STATUS.RUNNING ? 'IN PROGRESS' : 'queued';
    const tries = t.attempts > 1 ? `, attempt ${t.attempts}` : '';
    const why = t.error ? `\n    last failure: ${t.error}` : '';
    return `  [${t.id}] ${t.title} (${state}${tries})${why}`;
  });

  return `Work already written down and still outstanding — do these rather than
re-deciding what to do, and finish one before starting the next:
${lines.join('\n')}

Claim one with start_task, then complete_task or fail_task when you know the
outcome. A task you never report stays claimed and blocks the queue, so
report the failure rather than going quiet.`;
}
