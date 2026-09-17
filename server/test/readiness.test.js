// The point of this file is the agreement test at the bottom.
//
// A readiness report that disagrees with the gate it describes is worse than
// no report: a team told it is clear and then refused stops believing either,
// and the next thing it does is guess. So these tests walk a venture through
// every state it can be in and assert that "ready" and "the authorizer does
// not throw" are the same thing, in both directions.
//
// The rest checks what the report says, which matters almost as much. The
// failure this was built for was not "the team could not deploy" — it was the
// team reporting "blocked" for three days without naming the door.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deployReadiness, outreachReadiness, formatReadiness, formatReadinessBrief } from '../readiness.js';
import {
  createVenture,
  linkRepo,
  setDeploymentEnabled,
  linkOutreachScope,
  setOutreachEnabled,
  authorizeDeployment,
  authorizeOutreach,
  killVenture,
} from '../finance/ventures.js';
import { haltRealActions, resumeRealActions } from '../killSwitch.js';

let tmpDir;
let savedToken;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-readiness-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  savedToken = process.env.GITHUB_TOKEN;
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedToken;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of ['ventures.json', 'killSwitch.json', 'spend.json']) {
    fs.rmSync(path.join(tmpDir, file), { force: true });
  }
  process.env.GITHUB_TOKEN = 'test-token';
});

function freshVenture() {
  return createVenture({ title: 'App', oneLiner: 'x', proposedBy: 'venture_partner' });
}

function named(report, name) {
  return report.gates.find((g) => g.name === name);
}

// --- What it reports ----------------------------------------------------------

test('a venture with nothing set up names the first shut door, not all of them at once', () => {
  const venture = freshVenture();
  const report = deployReadiness(venture.id);
  assert.equal(report.ready, false);
  assert.equal(named(report, 'Repo linked').open, false);
  // The first shut gate is the one an attempt would actually hit. Without it a
  // team fixes the third thing on the list and tries again.
  assert.equal(report.blockedBy.name, 'Repo linked');
});

test('open gates are reported too, not only the shut ones', () => {
  // A list containing only failures reads as "everything is broken" whatever
  // it says, and the difference between one shut door and eleven is the
  // difference between a message to the founder and a strategy conversation.
  const venture = freshVenture();
  const report = deployReadiness(venture.id);
  assert.ok(report.gates.some((g) => g.open), 'the report must show what already works');
  assert.equal(named(report, 'GitHub configured').open, true);
  assert.equal(named(report, 'Real actions allowed').open, true);
});

test('every shut gate carries what would open it', () => {
  const venture = freshVenture();
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  const report = deployReadiness(venture.id);
  const enabled = named(report, 'Deployments enabled');
  assert.equal(enabled.open, false);
  // "Deployments are not enabled" tells an agent it is stuck. This tells it
  // what to ask for, which is the difference between a blocked day and a
  // one-line message to the founder.
  assert.match(enabled.fix, /founder turns this on/i);
});

test('the halt is reported as a halt, with the founder reason', () => {
  const venture = freshVenture();
  haltRealActions('Card declined');
  const report = deployReadiness(venture.id);
  const halt = named(report, 'Real actions allowed');
  assert.equal(halt.open, false);
  assert.match(halt.detail, /Card declined/);
  assert.equal(report.blockedBy.name, 'Real actions allowed');
  resumeRealActions();
});

test('without a path the allowlist is reported rather than judged', () => {
  // "What can I touch" is the question that actually precedes a deploy.
  const venture = freshVenture();
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/', 'docs/'], maxPerWeek: 5 });
  setDeploymentEnabled(venture.id, true);
  const report = deployReadiness(venture.id);
  const scope = named(report, 'Path in scope');
  assert.equal(scope.open, true);
  assert.match(scope.detail, /src\/, docs\//);
});

test('a path outside the scope is named, with the scope it fell outside', () => {
  const venture = freshVenture();
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  setDeploymentEnabled(venture.id, true);
  const report = deployReadiness(venture.id, { path: 'infra/prod.tf' });
  const scope = named(report, 'Path in scope');
  assert.equal(scope.open, false);
  assert.match(scope.detail, /outside/);
  assert.match(scope.fix, /widen the scope/);
});

test('a killed venture stops the report early rather than listing repo gates', () => {
  const venture = freshVenture();
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  setDeploymentEnabled(venture.id, true);
  killVenture(venture.id, { reason: 'No traction' });
  const report = deployReadiness(venture.id);
  assert.equal(report.ready, false);
  assert.equal(named(report, 'Venture active').open, false);
  assert.equal(named(report, 'Repo linked'), undefined, 'nothing past a killed venture is worth listing');
});

test('an unknown venture says so instead of reporting eleven irrelevant gates', () => {
  const report = deployReadiness('v_nonexistent');
  assert.equal(report.ready, false);
  assert.match(report.blockedBy.detail, /No venture with id/);
});

test('outreach readiness mentions whether replies are visible at all', () => {
  // Nothing blocks on it, but a company that can send and not receive is
  // broken in a way no refusal would ever mention.
  const venture = freshVenture();
  const report = outreachReadiness(venture.id);
  const inbox = report.gates.find((g) => g.name === 'Replies visible');
  assert.ok(inbox, 'the outreach report must say whether the company can hear back');
  assert.match(inbox.fix, /IMAP_HOST/);
});

// --- How it reads -------------------------------------------------------------

test('the formatted report shows the checks that pass as well as the ones that do not', () => {
  const venture = freshVenture();
  const text = formatReadiness(deployReadiness(venture.id));
  assert.match(text, /\[ok\]/);
  assert.match(text, /\[--\]/);
  assert.match(text, /First thing an attempt would hit/);
  assert.match(text, /What opens them/);
});

test('a ready venture says so plainly', () => {
  const venture = freshVenture();
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  setDeploymentEnabled(venture.id, true);
  const text = formatReadiness(deployReadiness(venture.id, { path: 'src/main.py' }));
  assert.match(text, /^Ready to deploy/);
  assert.doesNotMatch(text, /\[--\]/);
});

// --- The agreement ------------------------------------------------------------

test('ready and "the authorizer permits it" are the same thing, at every stage', () => {
  const venture = freshVenture();
  const check = (label) => {
    const report = deployReadiness(venture.id, { path: 'src/main.py' });
    let threw = null;
    try {
      authorizeDeployment(venture.id, { path: 'src/main.py' });
    } catch (err) {
      threw = err.message;
    }
    assert.equal(
      report.ready,
      threw === null,
      `${label}: readiness said ${report.ready ? 'ready' : 'not ready'} but the gate ${threw ? `threw "${threw}"` : 'permitted it'}`,
    );
    return report;
  };

  check('nothing set up');
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  check('repo linked, not enabled');
  setDeploymentEnabled(venture.id, true);
  const ready = check('fully set up');
  assert.equal(ready.ready, true);

  haltRealActions('Stop');
  check('halted');
  resumeRealActions();

  killVenture(venture.id, { reason: 'done' });
  check('killed');
});

test('the same agreement holds for outreach', () => {
  const venture = freshVenture();
  const check = (label) => {
    const report = outreachReadiness(venture.id, { to: 'ada@acme.com' });
    let threw = null;
    try {
      authorizeOutreach(venture.id, { to: 'ada@acme.com' });
    } catch (err) {
      threw = err.message;
    }
    // The inbox gate is reported but never blocks, so it is excluded from the
    // comparison — it is information, not permission.
    const blocking = report.gates.filter((g) => g.name !== 'Replies visible' && g.name !== 'Email configured');
    const allOpen = blocking.every((g) => g.open);
    assert.equal(allOpen, threw === null, `${label}: report and gate disagree (${threw || 'permitted'})`);
  };

  check('no scope');
  linkOutreachScope(venture.id, { allowedRecipients: ['ada@acme.com'], maxPerWeek: 5 });
  check('scope set, not enabled');
  setOutreachEnabled(venture.id, true);
  check('enabled');
});

// --- The founder's version ------------------------------------------------------
//
// The founder asked "why is the team constantly blocked, what can I do to
// support". The report that answers it was built for agents and reachable only
// by them — so the company could answer the question and the person who needed
// it could not ask. These cover the other end of that.

test('the brief drops everything that already works', () => {
  // formatReadiness shows open gates on purpose, for an agent. None of that
  // reasoning transfers: the founder is on a phone, and twelve lines with two
  // lines of signal do not get read, they get scrolled.
  const venture = freshVenture();
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  const brief = formatReadinessBrief(deployReadiness(venture.id));

  assert.doesNotMatch(brief, /\[ok\]/);
  assert.match(brief, /Deployments enabled/);
  assert.ok(brief.split('\n').length < 10, `the brief is ${brief.split('\n').length} lines — too long for a phone`);
});

test('the brief leads with what the founder can type', () => {
  const venture = freshVenture();
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  const brief = formatReadinessBrief(deployReadiness(venture.id));
  // "Turn it on in the Ventures panel" is a task. "DEPLOY ON v_123" is done
  // before they have put the phone down.
  assert.match(brief, new RegExp(`DEPLOY ON ${venture.id}`));
});

test('gates the founder cannot open from a message are still named', () => {
  // Silently omitting them would leave the founder believing the typed
  // commands are the whole story.
  const venture = freshVenture();
  linkOutreachScope(venture.id, { allowedRecipients: ['ada@acme.com'], maxPerWeek: 5 });
  const brief = formatReadinessBrief(outreachReadiness(venture.id));
  assert.match(brief, /Railway settings/);
  assert.match(brief, /SMTP_HOST/);
});

test('a clear venture says so in one line', () => {
  const venture = freshVenture();
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  setDeploymentEnabled(venture.id, true);
  assert.equal(formatReadinessBrief(deployReadiness(venture.id)), 'Nothing is blocking deploy.');
});

test('every founderCommand is one the command parser actually accepts', async () => {
  // A report that tells the founder to send something the parser rejects is
  // worse than one that stays quiet: they send it, nothing happens, and they
  // stop trusting the report.
  const { parseFounderCommand } = await import('../channels/founderCommands.js');
  const venture = freshVenture();
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  linkOutreachScope(venture.id, { allowedRecipients: ['ada@acme.com'], maxPerWeek: 5 });

  const gates = [
    ...deployReadiness(venture.id, { path: 'nope/outside.txt' }).gates,
    ...outreachReadiness(venture.id, { to: 'stranger@elsewhere.com' }).gates,
  ];
  const commands = gates.map((g) => g.founderCommand).filter(Boolean);
  assert.ok(commands.length >= 2, 'expected several typable fixes to check');

  for (const command of commands) {
    // Placeholders are for the founder to fill in, not for the parser.
    if (command.includes('<')) continue;
    assert.ok(parseFounderCommand(command), `the report suggests "${command}", which the parser does not accept`);
  }
});
