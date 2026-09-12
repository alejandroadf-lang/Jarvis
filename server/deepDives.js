// Questions that were too big for a two-minute answer.
//
// A turn that fans out across twenty-one agents can take many minutes, and a
// founder holding a phone will read that as broken long before it is. So the
// interactive turn stops widening at a deadline and answers with what it has,
// and the question it could not do justice to is queued here to be done
// properly and delivered when it is finished.
//
// The point is not to make hard questions fast. It is to stop a hard question
// looking like a failure, and to stop the answer to it being a rushed one
// nobody labelled as rushed.

import { readJson, writeJson } from './store.js';

const FILE = 'deepDives.json';
const MAX_KEPT = 100;

export const DIVE_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
};

function load() {
  const data = readJson(FILE, { dives: [] });
  if (!Array.isArray(data.dives)) data.dives = [];
  return data;
}

function save(data) {
  // Finished ones are history; the queue is what matters. Trimmed from the
  // front so a long-running deployment doesn't carry months of answers into
  // every read.
  if (data.dives.length > MAX_KEPT) data.dives = data.dives.slice(-MAX_KEPT);
  writeJson(FILE, data);
}

export function enqueue({ question, sessionId, deliverTo, reason }) {
  if (!question || !question.trim()) throw new Error('A deep dive needs a question.');

  const data = load();
  const dive = {
    id: `dive_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    question: question.trim(),
    sessionId: sessionId || null,
    // Where the answer goes when it's ready. Null means nowhere, and the
    // answer only appears in the app — worth being explicit about, since a
    // report nobody is told about is close to no report.
    deliverTo: deliverTo || null,
    reason: reason || null,
    status: DIVE_STATUS.QUEUED,
    requestedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    answer: null,
    error: null,
  };
  data.dives.push(dive);
  save(data);
  return dive;
}

function update(id, changes) {
  const data = load();
  const dive = data.dives.find((d) => d.id === id);
  if (!dive) return null;
  Object.assign(dive, changes);
  save(data);
  return dive;
}

/**
 * The next one to work on, or null.
 *
 * Anything already marked running is left alone: a restart mid-dive would
 * otherwise re-run it, and these are expensive. It stays visible as a stuck
 * row rather than quietly repeating.
 */
export function nextQueued() {
  return load().dives.find((d) => d.status === DIVE_STATUS.QUEUED) || null;
}

export function markRunning(id) {
  return update(id, { status: DIVE_STATUS.RUNNING, startedAt: new Date().toISOString() });
}

export function complete(id, answer) {
  return update(id, { status: DIVE_STATUS.DONE, answer, finishedAt: new Date().toISOString() });
}

export function fail(id, error) {
  return update(id, { status: DIVE_STATUS.FAILED, error, finishedAt: new Date().toISOString() });
}

export function listDeepDives(limit = 20) {
  return load().dives.slice(-limit).reverse();
}

export function getDeepDive(id) {
  return load().dives.find((d) => d.id === id) || null;
}

export function queueDepth() {
  return load().dives.filter((d) => d.status === DIVE_STATUS.QUEUED).length;
}
