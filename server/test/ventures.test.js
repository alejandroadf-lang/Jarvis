import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ventures;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ventures-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeVenture(overrides = {}) {
  return ventures.createVenture({
    title: 'Test Venture',
    oneLiner: 'Does a thing',
    problem: 'A problem',
    targetCustomer: 'Someone',
    businessModel: 'Subscription',
    marketSize: 'Big',
    pathToMillions: 'Scale it',
    milestones: ['Ship an MVP', 'Get first customer'],
    ...overrides,
  });
}

// Starting a venture costs nothing now, so there's no capital gate to pass
// and no 'proposed' waiting room to sit in — it's active the moment the
// studio starts it. Real-world reach is still granted separately, per
// venture, by the founder (see the authorize* tests below).
test('createVenture normalizes string milestones and starts active', () => {
  const v = makeVenture();
  assert.equal(v.status, 'active');
  assert.equal(v.milestones.length, 2);
  assert.deepEqual(v.milestones[0], { title: 'Ship an MVP', status: 'pending' });
});

test('the capital-model funding API is gone entirely', () => {
  assert.equal(ventures.activateVenture, undefined);
  assert.equal(ventures.requestTranche, undefined);
  assert.equal(ventures.approveTranche, undefined);
  assert.equal(ventures.denyTranche, undefined);
});

test('a venture carries no budget or tranche state', () => {
  const v = makeVenture({ budgetRequested: 20 });
  assert.equal(v.budgetRequested, undefined);
  assert.equal(v.pendingTranche, undefined);
  assert.equal(v.tranches, undefined);
});

test('setMilestoneStatus updates the right milestone and validates status', () => {
  const v = makeVenture();
  const updated = ventures.setMilestoneStatus(v.id, 0, 'done', 'shipped it');
  assert.equal(updated.milestones[0].status, 'done');
  assert.equal(updated.milestones[0].note, 'shipped it');
  assert.equal(updated.milestones[1].status, 'pending');
  assert.throws(() => ventures.setMilestoneStatus(v.id, 0, 'bogus'), /Invalid milestone status/);
  assert.throws(() => ventures.setMilestoneStatus(v.id, 99, 'done'), /No milestone at index/);
});

test('killVenture sets status and reason, and refuses to kill twice', () => {
  const v = makeVenture();

  const killed = ventures.killVenture(v.id, 'market did not want this');
  assert.equal(killed.status, 'killed');
  assert.equal(killed.killReason, 'market did not want this');

  assert.throws(() => ventures.killVenture(v.id, 'again'), /already killed/);
});

test('getVenture returns null for an unknown id, findOrThrow paths error clearly', () => {
  assert.equal(ventures.getVenture('nope'), null);
  assert.throws(() => ventures.killVenture('nope', 'x'), /Venture not found/);
});

// A killed venture is the one status that still blocks real actions — the
// active check outlived the capital model because it stops a venture the
// founder has walked away from from still deploying or emailing.
test('authorizeDeployment refuses a killed venture, an unlinked repo, and a disabled scope', () => {
  const killedVenture = makeVenture();
  ventures.killVenture(killedVenture.id, 'shut down');
  assert.throws(
    () => ventures.authorizeDeployment(killedVenture.id, { path: 'content/home.md' }),
    /must be active/
  );

  const v = makeVenture();
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/home.md' }), /No repo linked/);

  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'] });
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/home.md' }), /not enabled/);
});

test('authorizeDeployment enforces the path allowlist once enabled', () => {
  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/', 'config.json'] });
  ventures.setDeploymentEnabled(v.id, true);

  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'content/home.md' }));
  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'config.json' }));
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'server/index.js' }), /outside the allowed scope/);
});

test('authorizeDeployment enforces the weekly cap from recordDeployment history', () => {
  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'], maxPerWeek: 2 });
  ventures.setDeploymentEnabled(v.id, true);

  ventures.recordDeployment(v.id, { path: 'content/a.md', message: 'a', commitSha: 's1', commitUrl: 'u1' });
  ventures.recordDeployment(v.id, { path: 'content/b.md', message: 'b', commitSha: 's2', commitUrl: 'u2' });

  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/c.md' }), /Weekly deployment cap reached/);
});

test('setDeploymentEnabled requires a linked repo first', () => {
  const v = makeVenture();
  assert.throws(() => ventures.setDeploymentEnabled(v.id, true), /Link a repo before/);
});

test('recordDeployment appends to the deployment log with a timestamp', () => {
  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'] });

  const { venture, entry } = ventures.recordDeployment(v.id, {
    path: 'content/home.md',
    message: 'update copy',
    commitSha: 'abc123',
    commitUrl: 'https://github.com/acme/landing/commit/abc123',
    rationale: 'founder asked for new headline',
  });
  assert.equal(venture.deployments.length, 1);
  assert.equal(entry.path, 'content/home.md');
  assert.equal(entry.commitSha, 'abc123');
  assert.ok(entry.deployedAt);
  assert.equal(entry.triggeredBy, 'interactive'); // default when not specified
});

test('recordDeployment records triggeredBy as daily_cycle when told to, and normalizes anything else to interactive', () => {
  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'] });

  const daily = ventures.recordDeployment(v.id, { path: 'content/a.md', triggeredBy: 'daily_cycle' });
  assert.equal(daily.entry.triggeredBy, 'daily_cycle');

  const bogus = ventures.recordDeployment(v.id, { path: 'content/b.md', triggeredBy: 'something_else' });
  assert.equal(bogus.entry.triggeredBy, 'interactive');
});

test('authorizeDeployment enforces the daily cap before the weekly one is anywhere near spent', () => {
  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'], maxPerWeek: 5, maxPerDay: 2 });
  ventures.setDeploymentEnabled(v.id, true);

  // Two today, well under the weekly cap of 5 — but the daily cap is 2.
  ventures.recordDeployment(v.id, { path: 'content/a.md' });
  ventures.recordDeployment(v.id, { path: 'content/b.md' });

  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/c.md' }), /Daily deployment cap reached \(2\/day\)/);
});

test('a venture linked without a daily cap defaults to one real action per day', () => {
  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'], maxPerWeek: 5 });
  ventures.setDeploymentEnabled(v.id, true);

  assert.equal(ventures.getVenture(v.id).repo.maxPerDay, 1);
  ventures.recordDeployment(v.id, { path: 'content/a.md' });
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/b.md' }), /Daily deployment cap reached \(1\/day\)/);
});

test('a daily cap above the weekly cap is clamped, since it could never bind', () => {
  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'], maxPerWeek: 2, maxPerDay: 99 });
  assert.equal(ventures.getVenture(v.id).repo.maxPerDay, 2);
});

test('the cooldown blocks a second real action fired seconds after the first', () => {
  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'], maxPerWeek: 9, maxPerDay: 9 });
  ventures.setDeploymentEnabled(v.id, true);

  ventures.recordDeployment(v.id, { path: 'content/a.md' });
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/b.md' }), /cooldown between real actions/);
});

test('an action from outside the cooldown window is allowed again', () => {
  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'], maxPerWeek: 9, maxPerDay: 9 });
  ventures.setDeploymentEnabled(v.id, true);
  ventures.recordDeployment(v.id, { path: 'content/a.md' });

  // Backdate the entry on disk past the cooldown, but well inside both caps'
  // windows — so the only thing that could still block is the cooldown.
  const file = path.join(tmpDir, 'ventures.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const stored = data.ventures.find((venture) => venture.id === v.id);
  stored.deployments[0].deployedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'content/b.md' }));
});

test('authorizeOutreach refuses a killed venture, an unset scope, and a disabled scope', () => {
  const killedVenture = makeVenture();
  ventures.killVenture(killedVenture.id, 'shut down');
  assert.throws(() => ventures.authorizeOutreach(killedVenture.id, { to: 'x@acme.com' }), /must be active/);

  const v = makeVenture();
  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'x@acme.com' }), /No outreach scope/);

  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });
  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'x@acme.com' }), /not enabled/);
});

test('authorizeOutreach enforces the recipient allowlist, matching exact addresses and whole domains', () => {
  const v = makeVenture();
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['jane@acme.com', '@partner.com'] });
  ventures.setOutreachEnabled(v.id, true);

  assert.doesNotThrow(() => ventures.authorizeOutreach(v.id, { to: 'jane@acme.com' }));
  assert.doesNotThrow(() => ventures.authorizeOutreach(v.id, { to: 'anyone@partner.com' }));
  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'someoneelse@acme.com' }), /outside the allowed recipients/);
  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'random@nowhere.com' }), /outside the allowed recipients/);
});

test('authorizeOutreach enforces the weekly cap from recordOutreach history', () => {
  const v = makeVenture();
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'], maxPerWeek: 2 });
  ventures.setOutreachEnabled(v.id, true);

  ventures.recordOutreach(v.id, { to: 'a@acme.com', subject: 'a', body: 'x' });
  ventures.recordOutreach(v.id, { to: 'b@acme.com', subject: 'b', body: 'x' });

  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'c@acme.com' }), /Weekly outreach cap reached/);
});

test('setOutreachEnabled requires a scope to already be set up', () => {
  const v = makeVenture();
  assert.throws(() => ventures.setOutreachEnabled(v.id, true), /Set up an outreach scope before/);
});

test('recordOutreach appends to the sent-email log with a timestamp', () => {
  const v = makeVenture();
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });

  const { venture, entry } = ventures.recordOutreach(v.id, {
    to: 'jane@acme.com',
    subject: 'Following up',
    body: 'Here is the proposal we discussed.',
  });
  assert.equal(venture.sentEmails.length, 1);
  assert.equal(entry.to, 'jane@acme.com');
  assert.equal(entry.subject, 'Following up');
  assert.ok(entry.sentAt);
  assert.equal(entry.triggeredBy, 'interactive'); // default when not specified
});

test('listContacts derives history from the sent log, newest contact first', () => {
  const v = makeVenture();
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });

  ventures.recordOutreach(v.id, { to: 'jane@acme.com', subject: 'Intro' });
  ventures.recordOutreach(v.id, { to: 'jane@acme.com', subject: 'Following up' });
  ventures.recordOutreach(v.id, { to: 'bob@acme.com', subject: 'Hello' });

  const contacts = ventures.listContacts(v.id);
  assert.equal(contacts.length, 2);

  const jane = contacts.find((c) => c.email === 'jane@acme.com');
  assert.equal(jane.emailCount, 2);
  assert.equal(jane.lastSubject, 'Following up'); // the most recent one, not the first
  assert.ok(jane.lastSentAt);
});

test('listContacts matches addresses case-insensitively rather than splitting one person in two', () => {
  const v = makeVenture();
  ventures.recordOutreach(v.id, { to: 'Jane@Acme.com', subject: 'One' });
  ventures.recordOutreach(v.id, { to: 'jane@acme.com', subject: 'Two' });

  const contacts = ventures.listContacts(v.id);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].emailCount, 2);
});

test('recordContactNote attaches a note to a contact and keeps it in listContacts', () => {
  const v = makeVenture();
  ventures.recordOutreach(v.id, { to: 'jane@acme.com', subject: 'Intro' });
  ventures.recordContactNote(v.id, { email: 'JANE@acme.com', note: 'Asked for pricing in Q3' });

  const jane = ventures.listContacts(v.id).find((c) => c.email === 'jane@acme.com');
  assert.equal(jane.notes.length, 1);
  assert.equal(jane.notes[0].note, 'Asked for pricing in Q3');
  assert.ok(jane.notes[0].at);
});

test('a contact can exist on a note alone, before anything has been sent to them', () => {
  const v = makeVenture();
  ventures.recordContactNote(v.id, { email: 'newlead@acme.com', note: 'Met at a meetup' });

  const contacts = ventures.listContacts(v.id);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].emailCount, 0);
  assert.equal(contacts[0].lastSentAt, null);
});

test('recordContactNote requires both an address and a note', () => {
  const v = makeVenture();
  assert.throws(() => ventures.recordContactNote(v.id, { email: '   ', note: 'x' }), /email is required/);
  assert.throws(() => ventures.recordContactNote(v.id, { email: 'a@b.com', note: '  ' }), /note is required/);
});

test('contact notes are capped so working memory cannot grow without bound', () => {
  const v = makeVenture();
  for (let i = 1; i <= 8; i++) {
    ventures.recordContactNote(v.id, { email: 'jane@acme.com', note: `note ${i}` });
  }

  const jane = ventures.listContacts(v.id).find((c) => c.email === 'jane@acme.com');
  assert.equal(jane.notes.length, 5);
  assert.equal(jane.notes[0].note, 'note 4'); // oldest kept
  assert.equal(jane.notes[4].note, 'note 8'); // newest
});

test('the global halt overrides a fully-granted scope for both real actions', async () => {
  const killSwitch = await import('../killSwitch.js');

  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'] });
  ventures.setDeploymentEnabled(v.id, true);
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });
  ventures.setOutreachEnabled(v.id, true);

  // Both would be authorized on their own merits.
  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'content/a.md' }));
  assert.doesNotThrow(() => ventures.authorizeOutreach(v.id, { to: 'jane@acme.com' }));

  killSwitch.haltRealActions('stop everything');
  try {
    assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/a.md' }), /halted/);
    assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'jane@acme.com' }), /halted/);
  } finally {
    killSwitch.resumeRealActions();
  }

  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'content/a.md' }));
});

test('recordOutreach records triggeredBy as daily_cycle when told to, and normalizes anything else to interactive', () => {
  const v = makeVenture();
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });

  const daily = ventures.recordOutreach(v.id, { to: 'a@acme.com', triggeredBy: 'daily_cycle' });
  assert.equal(daily.entry.triggeredBy, 'daily_cycle');

  const bogus = ventures.recordOutreach(v.id, { to: 'b@acme.com', triggeredBy: 'something_else' });
  assert.equal(bogus.entry.triggeredBy, 'interactive');
});

// The studio's whole premise: an idea has to name why an agent-run company
// wins at it. It's a required field on propose_venture, so it has to survive
// into the stored venture — otherwise execution loses the reason the thing
// was started.
test('a venture records why an agent-run company wins at it', () => {
  const v = makeVenture({ agentNativeEdge: 'Per-customer bespoke reports at a price no staffed firm can serve.' });
  assert.match(ventures.getVenture(v.id).agentNativeEdge, /no staffed firm can serve/);
});

test('a venture created without that reasoning stores an empty string, not undefined', () => {
  // Older ventures predate the field; they should read as blank rather than
  // putting "undefined" in front of an agent.
  const v = makeVenture();
  assert.equal(ventures.getVenture(v.id).agentNativeEdge, '');
});

// The service URL: a founder-granted scope, like the repo and the outreach
// allowlist, and for a sharper reason than either. The agent cannot name the
// host because an agent-chosen host makes check_service a server-side request
// forgery primitive (see execute/probe.js for the boundary itself). What is
// tested here is the grant: that it validates on the way in, that nothing can
// be probed without it, and that the kill switch still covers it.
test('setServiceUrl stores the origin only, and refuses a URL that could not be probed', () => {
  const v = makeVenture();

  const linked = ventures.setServiceUrl(v.id, 'https://circadian-api.up.railway.app/health?x=1');
  // The origin, not the path: the grant is the host, and the agent supplies
  // the path on each call.
  assert.equal(linked.service.origin, 'https://circadian-api.up.railway.app');

  // Validated here rather than at probe time, so a stored URL can never be one
  // the probe would later refuse — a grant that looks live and is not is the
  // failure shape this codebase keeps hitting.
  assert.throws(() => ventures.setServiceUrl(v.id, 'http://circadian-api.up.railway.app'), /https/);
  assert.throws(() => ventures.setServiceUrl(v.id, 'https://169.254.169.254'), /IP address/);
  assert.throws(() => ventures.setServiceUrl(v.id, 'https://localhost'), /public address/);
  // And the bad attempts left the good grant alone.
  assert.equal(ventures.getVenture(v.id).service.origin, 'https://circadian-api.up.railway.app');
});

test('authorizeProbe refuses when no URL is set, and says the founder has to provide it', () => {
  const v = makeVenture();
  assert.throws(() => ventures.authorizeProbe(v.id), /No service URL/);
  // Specifically: not something the agent can work around, and CI is not a
  // substitute answer. Both clauses are the ones that stop a turn from
  // reporting "live" off a green check.
  assert.throws(() => ventures.authorizeProbe(v.id), /cannot choose it yourself/);
  assert.throws(() => ventures.authorizeProbe(v.id), /CI run is not evidence/);
});

test('clearServiceUrl revokes it', () => {
  const v = makeVenture();
  ventures.setServiceUrl(v.id, 'https://api.example.com');
  assert.equal(ventures.authorizeProbe(v.id), 'https://api.example.com');
  ventures.clearServiceUrl(v.id);
  assert.throws(() => ventures.authorizeProbe(v.id), /No service URL/);
});

// A read-only GET against the founder's own service is mild next to a commit
// or an email. It is still gated on the kill switch, because "HALT means
// nothing leaves this server" is a promise the founder can rely on, and a
// carve-out for this one makes it a promise they have to reason about.
test('the kill switch covers the probe too', async () => {
  const killSwitch = await import('../killSwitch.js');
  const v = makeVenture();
  ventures.setServiceUrl(v.id, 'https://api.example.com');

  killSwitch.haltRealActions('testing');
  try {
    assert.throws(() => ventures.authorizeProbe(v.id), /halted/i);
  } finally {
    killSwitch.resumeRealActions();
  }
  assert.equal(ventures.authorizeProbe(v.id), 'https://api.example.com');
});

// Rate-limited rather than capped per day: checking your work often is the
// behaviour this tool exists to encourage. What it has to stop is a retry loop
// inside one turn hammering the venture's own service for the same answer.
test('probes are rate-limited per minute, and the refusal says why retrying will not help', () => {
  const v = makeVenture();
  ventures.setServiceUrl(v.id, 'https://api.example.com');

  for (let i = 0; i < 6; i += 1) {
    assert.equal(ventures.authorizeProbe(v.id), 'https://api.example.com');
    ventures.recordProbe(v.id, { path: '/health', status: 500, ok: false, ms: 12, agentId: 'engineering_lead' });
  }
  assert.throws(() => ventures.authorizeProbe(v.id), /read the last result instead/);
});

test('the probe log keeps what happened, newest first, and does not grow without limit', () => {
  const v = makeVenture();
  ventures.setServiceUrl(v.id, 'https://api.example.com');

  for (let i = 0; i < 14; i += 1) {
    ventures.recordProbe(v.id, { path: `/p${i}`, status: 200, ok: true, ms: i, agentId: 'engineering_lead' });
  }
  const probes = ventures.listProbes(v.id);
  assert.equal(probes.length, 10, 'this is evidence of whether it is up now, not an archive');
  assert.equal(probes[0].path, '/p13');
  assert.equal(probes[0].agentId, 'engineering_lead');
});
