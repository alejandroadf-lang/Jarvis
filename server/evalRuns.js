// What the eval said, kept.
//
// The eval printed a score to whoever ran it and forgot it. That made it a
// ceremony rather than an instrument: nothing could ask "is the team better
// than last week", the weekly reflection could not see what failed, and the
// graph could not show which agent keeps failing which judgment. Every one of
// those needs the result to exist somewhere after the terminal scrolls.

import { readJson, writeJson } from './store.js';

const FILE = 'evalRuns.json';
const RUNS_KEPT = 26; // half a year of weekly runs

function load() {
  return readJson(FILE, { runs: [] });
}

/**
 * Parses the runner's stdout into rows. Deliberately tolerant: the runner's
 * output is for a person first, and a format change should degrade to fewer
 * rows rather than a crash in the scheduler that called it.
 */
export function parseEvalOutput(output) {
  const lines = String(output || '').split('\n');
  const results = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\[(PASS|FAIL)\]\s+(\S+)(?:\s+·\s+agent=(\S+))?/);
    if (!m) continue;
    const notes = (lines[i + 2] || '').trim();
    results.push({ id: m[2], agentId: m[3] || null, pass: m[1] === 'PASS', notes });
  }
  const score = lines.map((l) => l.match(/^(\d+)\/(\d+) passed/)).find(Boolean);
  const cost = lines.map((l) => l.match(/\$(\d+(?:\.\d+)?)/)).find(Boolean);
  return {
    results,
    passCount: score ? Number(score[1]) : results.filter((r) => r.pass).length,
    total: score ? Number(score[2]) : results.length,
    costUsd: cost ? Number(cost[1]) : null,
  };
}

export function recordEvalRun({ output, scenarioId = null, startedAt, ok }) {
  const parsed = parseEvalOutput(output);
  const run = {
    at: new Date().toISOString(),
    startedAt: startedAt || null,
    scenarioId,
    ok: Boolean(ok),
    ...parsed,
  };
  const data = load();
  data.runs.push(run);
  if (data.runs.length > RUNS_KEPT) data.runs = data.runs.slice(-RUNS_KEPT);
  writeJson(FILE, data);
  return run;
}

/** The most recent full run (not a single-scenario run), or null. */
export function latestEvalRun() {
  const runs = load().runs.filter((r) => !r.scenarioId);
  return runs.length ? runs[runs.length - 1] : null;
}

export function listEvalRuns() {
  return load().runs;
}

/**
 * Pass rate per agent from the latest full run — the register's number. Null
 * for an agent no scenario exercises, which is itself worth showing: an agent
 * with no eval is an agent whose judgment nobody has measured.
 */
export function agentPassRates() {
  const run = latestEvalRun();
  const rates = {};
  if (!run) return rates;
  const tally = {};
  for (const r of run.results) {
    if (!r.agentId) continue;
    tally[r.agentId] = tally[r.agentId] || { pass: 0, total: 0 };
    tally[r.agentId].total += 1;
    if (r.pass) tally[r.agentId].pass += 1;
  }
  for (const [id, t] of Object.entries(tally)) rates[id] = { ...t, rate: t.total ? t.pass / t.total : null };
  return rates;
}

/** The failures, phrased for the weekly reflection. */
export function describeLatestEvalForReflection() {
  const run = latestEvalRun();
  if (!run) return 'The behavioural eval has never run. Nothing here has been measured.';
  const failed = run.results.filter((r) => !r.pass);
  const head = `Latest eval (${run.at.slice(0, 10)}): ${run.passCount}/${run.total} passed${run.costUsd != null ? `, cost $${run.costUsd}` : ''}.`;
  if (!failed.length) return `${head} Every scenario passed.`;
  return `${head} Failed:\n${failed.map((r) => `  ✗ ${r.id}${r.agentId ? ` (${r.agentId})` : ''}: ${r.notes}`).join('\n')}`;
}
