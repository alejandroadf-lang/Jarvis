import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAMEWORKS, SIGNAL_MAP, coverage } from '../src/lib/frameworks.mjs';
import { INDICATOR_KEYS } from '../src/lib/score.mjs';
import { ENABLER_KEYS } from '../src/lib/enablers.mjs';
import { PULSE_ITEMS } from '../src/lib/pulse.mjs';
import { buildEvidence, evidenceMarkdown, evidenceHtml, attentionLevel } from '../src/lib/evidence.mjs';
import { disclosures } from '../src/lib/disclosures.mjs';
import { organisationLevel } from '../src/lib/levels.mjs';
import { canonical, newKeyPair, signAttestation, verifyAttestation, attestationPayload } from '../src/lib/attestation.mjs';
import { weeksOfQuarter, quarterOf, previousQuarter, nextQuarter, quarterRange } from '../src/lib/time.mjs';
import { createApp } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';

const quiet = { warn() {}, error() {}, log() {} };

test('quarters: ISO weeks by their Thursday, so each week belongs to one quarter', () => {
  assert.equal(quarterOf('2026-09-30'), '2026-Q3');
  assert.equal(previousQuarter('2026-Q1'), '2025-Q4');
  assert.equal(nextQuarter('2026-Q4'), '2027-Q1');
  assert.deepEqual(quarterRange('2026-Q1'), { first: '2026-01-01', last: '2026-03-31' });
  // 2026 has 53 ISO weeks (1 January is a Thursday); W53 falls in Q4.
  assert.equal(weeksOfQuarter('2026-Q4').length, 14);
  assert.equal(weeksOfQuarter('2026-Q4').at(-1), '2026-W53');
  // 2027-W13's Thursday is 1 April, so Q1 2027 has twelve weeks.
  assert.deepEqual([weeksOfQuarter('2027-Q1')[0], weeksOfQuarter('2027-Q1').length], ['2027-W01', 12]);
  const year = ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'].flatMap(weeksOfQuarter);
  assert.equal(new Set(year).size, 53);
});

test('the framework map: every signal is mapped, every category has a signal, nothing points nowhere', () => {
  // "match" asks whether the grade matched how the weeks felt: it checks the
  // app, it is not a hazard, so it maps to no category.
  const pulseHazards = PULSE_ITEMS.filter((i) => i.key !== 'match').map((i) => `pulse:${i.key}`);
  for (const key of [...INDICATOR_KEYS, ...ENABLER_KEYS, ...pulseHazards]) {
    assert.ok(SIGNAL_MAP[key], `${key} has no framework mapping`);
  }
  for (const [signal, map] of Object.entries(SIGNAL_MAP)) {
    for (const [fw, cats] of Object.entries(map)) {
      assert.ok(FRAMEWORKS[fw], `${signal} maps to unknown framework ${fw}`);
      for (const c of cats) assert.ok(FRAMEWORKS[fw].categories[c], `${signal} maps to unknown category ${fw}.${c}`);
    }
  }
  for (const fw of Object.keys(FRAMEWORKS)) {
    const cov = coverage(fw);
    for (const c of cov.categories) assert.ok(c.signals.length, `${fw}.${c.key} has no signal`);
    assert.ok(cov.notCovered.length, `${fw} must say what it does not cover`);
  }
  // A switched-off signal is no longer claimed as coverage.
  const without = coverage('iso45003', { disabled: { soloShare: false } });
  assert.ok(!without.categories.some((c) => c.signals.includes('soloShare')));
});

const weekRow = (week, grade, statuses, extra = {}) => ({ week, grade, suppressed: !grade, hasData: true, statuses, enablerStatuses: {}, ...extra });

function samplePack(overrides = {}) {
  const weeks = weeksOfQuarter('2026-Q3');
  const late = weeks.slice(-4);
  const early = weeks.slice(0, 4);
  const teams = [
    {
      name: 'Payments',
      weeks: [
        ...early.map((w) => weekRow(w, 'E', { afterHoursShare: 'act', lateShare: 'act' })),
        ...late.map((w) => weekRow(w, 'C', { afterHoursShare: 'good', lateShare: 'watch' })),
      ],
      actions: { committed: 4, done: 3, closed: 4 },
      pulse: { on: true, tallies: [{ n: 6, items: { hours: [0, 1, 1, 2, 2], respect: [0, 0, 1, 2, 3] } }] },
    },
    {
      name: 'Web',
      weeks: [...late.map((w) => weekRow(w, null, {}, { suppressed: true }))],
      actions: { committed: 0, done: 0, closed: 0 },
      pulse: { on: false, tallies: [] },
    },
  ];
  return buildEvidence({
    product: 'jira',
    quarter: '2026-Q3',
    weeks,
    generatedAt: '2026-10-02T03:00:00.000Z',
    teams,
    summary: { coverage: 0.5, sustainableShare: 1, medianWeeksToRecover: 4, needSupport: [] },
    audit: [{ event: 'settings.save' }, { event: 'actions.commit' }],
    disabled: { soloShare: false },
    orgSettings: { consultationRecorded: true, consultationDate: '2026-06-15', organisationName: 'Acme' },
    ...overrides,
  });
}

test('the evidence pack: act-now shares and trends per hazard, suppressed weeks excluded, pulse only above the floor', () => {
  const p = samplePack();
  assert.equal(p.scope.teams, 2);
  assert.equal(p.scope.teamWeeks, 12);
  assert.equal(p.scope.suppressedShare, 4 / 12);
  assert.deepEqual(p.grades, { A: 0, B: 0, C: 4, D: 0, E: 4 });
  const off = p.hazards.find((h) => h.key === 'afterHoursShare');
  assert.equal(off.actShare, 0.5);
  assert.equal(off.attention, 'high');
  assert.equal(off.direction, 'improving');
  assert.equal(p.hazards[0].actShare >= p.hazards.at(-1).actShare, true, 'sorted by act-now share');
  assert.equal(p.actions.completion, 0.75);
  assert.equal(p.actions.teams, 1);
  const hours = p.participation.statements.find((s) => s.key === 'hours');
  assert.equal(hours.shown, true);
  assert.equal(hours.favourable, 4 / 6);
  assert.equal(p.participation.statements.find((s) => s.key === 'control').shown, false);
  assert.deepEqual(p.governance, { settingsChanges: 1, switchedOff: [p.governance.switchedOff[0]], auditEntries: 2 });
  assert.equal(attentionLevel(0.1), 'medium');
  assert.equal(attentionLevel(null), 'no data');
});

test('the pack as text names its limits and the use ban, and escapes for Confluence', () => {
  const p = samplePack({ orgSettings: { organisationName: 'R&D <Labs>' } });
  const md = evidenceMarkdown(p);
  assert.match(md, /screening input to a psychosocial risk assessment, not the assessment itself/);
  assert.match(md, /Not covered by this app/);
  assert.match(md, /ISO 45001:2018 clauses/);
  assert.match(md, /Consultation with workers' representatives recorded: no/);
  const html = evidenceHtml(p);
  assert.match(html, /R&amp;D &lt;Labs&gt;/);
  assert.ok(!html.includes('<Labs>'));
});

test('disclosure drafts are drafts, and B Corp is told what the app cannot do', () => {
  const d = disclosures(samplePack());
  assert.match(d.esrsS1.text, /not a measure of individual health/);
  assert.match(d.bCorpFairWork.caveat, /identity group/);
  assert.match(d.topEmployers.text, /prohibited/);
});

function levelPack({ consultation = true, shown = 1, acting = 0.6, completion = 0.6, pulse = 0.6, sustainable = 0.8, recovery = 3, quarter = '2026-Q3' } = {}) {
  return {
    quarter,
    scope: { teams: 10, suppressedShare: shown === null ? null : 1 - shown },
    actions: { teams: Math.round(acting * 10), completion },
    participation: { consultationRecorded: consultation, pulseTeams: Math.round(pulse * 10) },
    sustainableShare: sustainable,
    medianWeeksToRecover: recovery,
  };
}

test('levels climb Measuring, Acting, Sustaining, and say what the next one needs', () => {
  const none = organisationLevel(levelPack({ consultation: false }));
  assert.equal(none.level, 'none');
  assert.equal(none.next.level, 'measuring');
  assert.match(none.next.missing[0], /Workers’ representatives consulted/);

  const measuring = organisationLevel(levelPack({ completion: null }));
  assert.equal(measuring.level, 'measuring');
  assert.deepEqual(measuring.next.missing, ['At least 50% of closed actions done']);

  const acting = organisationLevel(levelPack());
  assert.equal(acting.level, 'acting', 'one good quarter is not yet Sustaining');
  assert.match(acting.next.missing.at(-1), /two quarters in a row/);

  const sustaining = organisationLevel(levelPack(), levelPack({ quarter: '2026-Q2' }));
  assert.equal(sustaining.level, 'sustaining');
  assert.equal(sustaining.next, null);

  // A quarter with no recoveries needed still counts; a slow one does not.
  assert.equal(organisationLevel(levelPack({ recovery: null }), levelPack()).level, 'sustaining');
  assert.equal(organisationLevel(levelPack({ recovery: 6 }), levelPack()).level, 'acting');
});

test('attestations: canonical, signed, and any change breaks them', () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
  const { privateKey, publicKey } = newKeyPair();
  const pack = samplePack();
  const level = organisationLevel(pack);
  const payload = attestationPayload({ pack, level, product: 'jira', issuedAt: '2026-10-02T09:00:00.000Z', validUntil: '2026-12-31' });
  assert.match(payload.statement, /not a certification/);
  const att = signAttestation(payload, privateKey, publicKey);
  assert.deepEqual(verifyAttestation(att), { valid: true, reason: 'signature valid' });
  const forged = JSON.parse(JSON.stringify(att));
  forged.payload.level = 'sustaining';
  assert.equal(verifyAttestation(forged).valid, false);
  const otherKey = newKeyPair();
  assert.match(verifyAttestation({ ...att, publicKey: otherKey.publicKey }).reason, /does not match|key id/);
  assert.equal(verifyAttestation({ payload: {} }).valid, false);

  // The offline verifier script.
  const dir = mkdtempSync(join(tmpdir(), 'hc-att-'));
  writeFileSync(join(dir, 'ok.json'), JSON.stringify(att));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify(forged));
  const out = execFileSync(process.execPath, ['scripts/verify-attestation.mjs', join(dir, 'ok.json'), att.keyId], { encoding: 'utf8' });
  assert.match(out, /^VALID/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/verify-attestation.mjs', join(dir, 'bad.json')], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, ['scripts/verify-attestation.mjs', join(dir, 'ok.json'), 'deadbeefdeadbeef'], { stdio: 'pipe' }));
});

// Six people active on weekdays in the last three weeks of Q3 2026.
async function populateQ3(app) {
  for (const monday of [7, 14, 21]) {
    for (let d = 0; d < 5; d++) {
      const day = `2026-09-${String(monday + d).padStart(2, '0')}`;
      for (let p = 0; p < 6; p++) {
        await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: `557058:${p}`, issue: { id: `1${p}`, key: `OPS-${p}`, fields: { updated: `${day}T10:00:00.000Z` } } });
      }
    }
  }
}

const tally = (n) => ({ n, items: { hours: [0, 0, 1, n - 2, 1] } });

test('the rollup packs the closed quarter once; only admins attest a level it reached, signed with a key kept secret', async () => {
  const store = memoryStore();
  const pages = [];
  const confluence = { createPage: async (spaceId, page) => (pages.push({ spaceId, ...page }), { id: '9001' }) };
  const app = createApp({ store, jira: { projectName: async () => 'Operations' }, confluence, now: () => new Date('2026-10-02T03:00:00Z'), log: quiet });
  await populateQ3(app);
  await store.set('pulse:jira:OPS:2026-09', tally(6));
  await store.set('pulse:jira:OPS:2026-08', tally(3)); // under the group floor: never counted
  await store.set('pulse:jira:OPS:2026-10', tally(6)); // still open: never counted
  const admin = { isAdmin: true };

  // Without recorded consultation, the quarter is packed but reaches no level.
  let r = await app.dailyRollup();
  assert.equal(r.evidencePacks, 1);
  assert.equal((await app.dailyRollup()).evidencePacks, undefined, 'packed once, never rebuilt');
  let view = await app.evidenceView({ product: 'jira', viewer: admin });
  assert.equal(view.quarter, '2026-Q3');
  assert.equal(view.live, false);
  assert.equal(view.pack.scope.teams, 1);
  assert.equal(view.pack.participation.responses, 6);
  const q = await store.get('qscores:jira:2026-Q3');
  assert.deepEqual(Object.keys(q), ['jira:OPS'], 'per-team quarter scores kept for the absence check');
  assert.equal(q['jira:OPS'].graded, 3);
  assert.equal(view.level.level, 'none');
  assert.ok(!view.markdown.includes('557058'), 'no account id in the pack');
  await assert.rejects(app.issueAttestation({ product: 'jira', viewer: admin, quarter: '2026-Q3' }), /did not reach Measuring.*consulted/);

  // A fresh installation that recorded consultation during the quarter.
  const store2 = memoryStore();
  const app2 = createApp({ store: store2, jira: { projectName: async () => 'Operations' }, confluence, now: () => new Date('2026-10-02T03:00:00Z'), log: quiet });
  await populateQ3(app2);
  await app2.saveOrgSettings({ product: 'jira', viewer: admin, settings: { groups: 'hr' } });
  await app2.saveOrgSettings({ product: 'jira', viewer: admin, settings: { consultationRecorded: true, consultationDate: '2026-07-01', organisationName: 'Acme' } });
  assert.deepEqual((await store2.get('org:jira')).groups, ['hr'], 'saving evidence settings keeps the access groups');
  await app2.dailyRollup();

  await assert.rejects(app2.evidenceView({ product: 'jira', viewer: { isAdmin: false, groups: [] } }), /Ask a site administrator/);
  view = await app2.evidenceView({ product: 'jira', viewer: { isAdmin: false, groups: ['HR'] } });
  assert.equal(view.level.level, 'measuring');
  assert.equal(view.canAttest, false);
  assert.deepEqual(view.quarters, ['2026-Q4', '2026-Q3']);

  const draft = await app2.evidenceView({ product: 'jira', viewer: admin, quarter: '2026-Q4' });
  assert.equal(draft.live, true);
  assert.equal(draft.canAttest, false);
  await assert.rejects(app2.evidenceView({ product: 'jira', viewer: admin, quarter: '2025-Q1' }), /no evidence pack for 2025-Q1/);
  await assert.rejects(app2.evidenceView({ product: 'jira', viewer: admin, quarter: 'Q3' }), /like 2026-Q3/);

  await assert.rejects(app2.issueAttestation({ product: 'jira', viewer: { isAdmin: false, groups: ['hr'] }, quarter: '2026-Q3' }), /Only site administrators/);
  await assert.rejects(app2.issueAttestation({ product: 'jira', viewer: admin, quarter: '2026-Q4' }), /no closed evidence pack/);
  const att = await app2.issueAttestation({ product: 'jira', viewer: admin, quarter: '2026-Q3', by: '557058:admin' });
  assert.equal(att.payload.level, 'measuring');
  assert.equal(att.payload.organisation, 'Acme');
  assert.equal(att.payload.validUntil, '2026-12-31');
  assert.equal(verifyAttestation(att).valid, true);
  const again = await app2.issueAttestation({ product: 'jira', viewer: admin, quarter: '2026-Q3' });
  assert.equal(again.keyId, att.keyId, 'one key per installation');
  const everything = JSON.stringify([...store2.data]);
  assert.ok(!everything.includes('PRIVATE KEY'), 'the private key lives in the secret store only');
  assert.ok(!everything.includes('557058:admin'), 'the admin is recorded by pseudonym');
  const log = await app2.auditEntries('org:jira');
  assert.ok(log.some((e) => e.event === 'attestation.issue' && e.by && e.detail.keyId === att.keyId));
  assert.equal((await app2.evidenceView({ product: 'jira', viewer: admin })).key.keyId, att.keyId);

  // Publishing: needs a space, happens once.
  await assert.rejects(app2.publishEvidence({ product: 'jira', viewer: admin, quarter: '2026-Q3' }), /space id for evidence pages/);
  await app2.saveOrgSettings({ product: 'jira', viewer: admin, settings: { evidenceSpaceId: '42' } });
  const published = await app2.publishEvidence({ product: 'jira', viewer: admin, quarter: '2026-Q3' });
  assert.equal(published.pageId, '9001');
  assert.equal(pages[0].spaceId, '42');
  assert.match(pages[0].title, /2026-Q3 \(Jira\), Acme/);
  await assert.rejects(app2.publishEvidence({ product: 'jira', viewer: admin, quarter: '2026-Q3' }), /already published/);
});

test('packs are only built in the first weeks of a quarter, and expire with the audit trail', async () => {
  const store = memoryStore();
  let clock = new Date('2026-10-25T03:00:00Z');
  const app = createApp({ store, now: () => clock, log: quiet });
  await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: 'u', issue: { id: '1', key: 'OPS-1', fields: { updated: '2026-10-20T10:00:00.000Z' } } });
  assert.equal((await app.dailyRollup()).evidencePacks, undefined);
  assert.equal(await store.get('evidence:jira:2026-Q3'), undefined, 'too late to pack a complete Q3');
  await store.set('evidence:jira:2023-Q2', { quarter: '2023-Q2', empty: true });
  await store.set('evidence:jira:2024-Q1', { quarter: '2024-Q1', empty: true });
  await app.dailyRollup();
  assert.equal(await store.get('evidence:jira:2023-Q2'), undefined);
  assert.ok(await store.get('evidence:jira:2024-Q1'));
  clock = new Date('2027-01-03T03:00:00Z');
  await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: 'u', issue: { id: '1', key: 'OPS-1', fields: { updated: '2026-12-29T10:00:00.000Z' } } });
  await app.dailyRollup();
  assert.deepEqual(await store.get('evidence:jira:2026-Q4').then((p) => [p.quarter, p.scope.teams]), ['2026-Q4', 1]);
});
