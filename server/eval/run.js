// Runs the behavioural eval from inside the running server, safely.
//
// "Safely" is the whole reason this file exists rather than a direct import.
// runner.mjs sets process.env.JARVIS_DATA_DIR to a throwaway directory so a
// scenario can create ventures and log revenue without touching anything
// real. store.js reads that variable on *every* call, not once at load — so
// importing the runner into the live server would silently redirect the whole
// application's storage to a temp directory for the duration of the run.
// A WhatsApp message arriving mid-eval would write its session there and lose
// it; a venture created in that window would vanish when the directory was
// cleaned up.
//
// A child process has its own environment. The eval gets its sandbox, the
// server keeps its volume, and neither has to know about the other.
//
// It also takes minutes and makes real, billed API calls, which is a second
// reason not to hold a request open for it: it is started, and the result is
// delivered when it exists.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.mjs');
const TIMEOUT_MS = Math.max(60_000, Number(process.env.EVAL_TIMEOUT_MS) || 15 * 60 * 1000);

let running = false;

export function isEvalRunning() {
  return running;
}

/**
 * Runs the eval to completion and returns what it printed.
 *
 * One at a time: two concurrent runs would double the bill and interleave
 * their output into something nobody can read.
 *
 * @param {{scenarioId?: string}} opts
 * @returns {Promise<{ok: boolean, output: string, summary: string}>}
 */
export async function runEval({ scenarioId } = {}) {
  if (running) throw new Error('An eval is already running — wait for it to finish.');
  running = true;

  try {
    const output = await new Promise((resolve, reject) => {
      const args = [RUNNER, ...(scenarioId ? [scenarioId] : [])];
      // The child inherits ANTHROPIC_API_KEY and the rest; JARVIS_DATA_DIR is
      // deliberately dropped rather than inherited, so that even if the
      // runner's own sandboxing changed, it could not be pointed at the live
      // volume by an environment it was never meant to read.
      const env = { ...process.env };
      delete env.JARVIS_DATA_DIR;

      const child = spawn(process.execPath, args, { env });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`The eval did not finish within ${Math.round(TIMEOUT_MS / 60000)} minutes and was stopped.`));
      }, TIMEOUT_MS);

      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.on('error', (spawnErr) => {
        clearTimeout(timer);
        reject(spawnErr);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // A non-zero exit with output is a failing eval, which is a result.
        // A non-zero exit with nothing on stdout is the runner refusing to
        // start — usually a missing key — and that message is the useful one.
        if (code !== 0 && !out.trim()) reject(new Error(err.trim() || `The eval exited with code ${code}.`));
        else resolve(out);
      });
    });

    return { ok: true, output, summary: summarise(output) };
  } finally {
    running = false;
  }
}

/**
 * The eval's output is pages long and a phone is not where you read pages.
 * This keeps the score, the cost, and the name of every scenario that failed
 * — which is the part that tells you what to go and look at.
 */
export function summarise(output) {
  const lines = output.split('\n');
  const failures = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\[FAIL\]\s+(\S+)/);
    if (match) {
      const why = (lines[i + 2] || '').trim();
      failures.push(`  ✗ ${match[1]}${why ? `\n     ${why}` : ''}`);
    }
  }

  const score = lines.find((l) => /\d+\s*\/\s*\d+/.test(l) && /pass|scenario/i.test(l));
  const cost = lines.find((l) => /\$/.test(l) && /cost|spent|total/i.test(l));

  if (!failures.length) {
    return `${score || 'Eval finished.'}\n${cost || ''}\n\nEvery scenario passed.`.trim();
  }
  return `${score || 'Eval finished.'}\n${cost || ''}\n\n${failures.length} failed:\n${failures.join('\n')}`.trim();
}
