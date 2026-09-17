// Why five turns went into guessing at one build failure.
//
// run_checks reported which step failed — "Run tests" — and linked a web page
// no agent has a browser for. The error itself, one line naming a file and a
// reason, was never in the reply. So a red build could only be answered with a
// theory, and in this company a theory costs a commit against the venture's
// cap to test.
//
// The real failure, for the record, was:
//   src/test_auth.py:23: from src.auth import (
//   E   ModuleNotFoundError: No module named 'src'
// which no amount of reasoning recovers and one line of log gives away.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { jobLogTail, failureSummary } from '../execute/githubActions.js';

let originalFetch;
let savedToken;

before(() => {
  originalFetch = global.fetch;
  savedToken = process.env.GITHUB_TOKEN;
});
after(() => {
  global.fetch = originalFetch;
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedToken;
});
beforeEach(() => {
  process.env.GITHUB_TOKEN = 'test-token';
});

// A log shaped like the real one: timestamped lines, the error in the middle,
// then GitHub's cleanup epilogue after it.
const RAW_LOG = [
  '2026-09-17T04:34:26.7550619Z ============================= test session starts ==============================',
  '2026-09-17T04:34:27.2431977Z collecting ... collected 0 items / 2 errors',
  '2026-09-17T04:34:27.2438297Z src/test_auth.py:23: in <module>',
  '2026-09-17T04:34:27.2441458Z     from src.auth import (',
  '2026-09-17T04:34:27.2442043Z E   ModuleNotFoundError: No module named \'src\'',
  '2026-09-17T04:34:27.2526950Z ============================== 2 errors in 0.46s ===============================',
  '2026-09-17T04:34:27.3017225Z ##[error]Process completed with exit code 2.',
  '2026-09-17T04:34:27.3158989Z Node 20 is being deprecated. This workflow is running with Node 24 by default.',
  '2026-09-17T04:34:27.3160485Z Post job cleanup.',
  '2026-09-17T04:34:27.4147082Z [command]/usr/bin/git version',
  '2026-09-17T04:34:27.4230100Z git version 2.55.0',
  '2026-09-17T04:34:27.7492009Z Cleaning up orphan processes',
].join('\n');

function stubLog(body, { ok = true } = {}) {
  global.fetch = async (url) => {
    if (String(url).endsWith('/logs')) return { ok, text: async () => body, status: ok ? 200 : 404 };
    throw new Error(`unstubbed ${url}`);
  };
}

test('the tail carries the error line itself, not a link to it', async () => {
  stubLog(RAW_LOG);
  const tail = await jobLogTail({ owner: 'a', repo: 'b', jobId: 1 });
  assert.match(tail, /ModuleNotFoundError: No module named 'src'/);
  assert.match(tail, /src\/test_auth\.py:23/);
});

test('timestamps are stripped, because they cost tokens and say nothing', async () => {
  stubLog(RAW_LOG);
  const tail = await jobLogTail({ owner: 'a', repo: 'b', jobId: 1 });
  assert.doesNotMatch(tail, /2026-09-17T04:34/);
});

test('the cleanup epilogue is trimmed so the tail ends at the real output', async () => {
  // Otherwise a 40-line tail is 35 lines of git plumbing and 5 of signal.
  stubLog(RAW_LOG);
  const tail = await jobLogTail({ owner: 'a', repo: 'b', jobId: 1 });
  assert.doesNotMatch(tail, /Post job cleanup/);
  assert.doesNotMatch(tail, /Cleaning up orphan processes/);
  assert.doesNotMatch(tail, /git version/);
  assert.doesNotMatch(tail, /Node 20 is being deprecated/);
  assert.match(tail.split('\n').pop(), /Process completed with exit code 2/);
});

test('a log that will not download is absent, never an exception', async () => {
  // A missing log is worse than having one. It is not a reason to turn a red
  // build into an error the agent cannot act on at all.
  stubLog('', { ok: false });
  assert.equal(await jobLogTail({ owner: 'a', repo: 'b', jobId: 1 }), null);

  global.fetch = async () => {
    throw new Error('network down');
  };
  assert.equal(await jobLogTail({ owner: 'a', repo: 'b', jobId: 1 }), null);
});

test('the tail is bounded, so one runaway job cannot fill a turn', async () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `2026-09-17T04:34:26.0000000Z line ${i}`).join('\n');
  stubLog(huge);
  const tail = await jobLogTail({ owner: 'a', repo: 'b', jobId: 1, lines: 40 });
  assert.equal(tail.split('\n').length, 40);
  assert.match(tail, /line 4999$/);
});

test('failureSummary attaches the log to the job that failed', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/jobs?per_page')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jobs: [
            { id: 11, name: 'test', conclusion: 'failure', html_url: 'https://gh/job/11', steps: [{ name: 'Run tests', conclusion: 'failure' }] },
            { id: 12, name: 'lint', conclusion: 'success', steps: [] },
          ],
        }),
      };
    }
    if (u.endsWith('/actions/jobs/11/logs')) return { ok: true, status: 200, text: async () => RAW_LOG };
    throw new Error(`unstubbed ${u}`);
  };

  const failures = await failureSummary({ owner: 'a', repo: 'b', runId: 99 });
  assert.equal(failures.length, 1, 'only the failed job');
  assert.equal(failures[0].job, 'test');
  assert.deepEqual(failures[0].failedSteps, ['Run tests']);
  assert.match(failures[0].logTail, /ModuleNotFoundError/);
});
