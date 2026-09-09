import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let dailyReports;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dailyreports-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  dailyReports = await import('../dailyReports.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeReport(date, overrides = {}) {
  return {
    date,
    generatedAt: `${date}T09:00:00.000Z`,
    leadership: { reply: 'status update', trace: [] },
    studio: { reply: 'nothing to propose today', trace: [] },
    proposedVentureIds: [],
    treasury: { balance: 100, startingCapital: 100 },
    ...overrides,
  };
}

test('todayKey formats a Date as YYYY-MM-DD in UTC', () => {
  assert.equal(dailyReports.todayKey(new Date('2026-03-05T23:30:00Z')), '2026-03-05');
});

test('listDailyReports starts empty, getLatestDailyReport is null, hasReportForToday is false', () => {
  assert.deepEqual(dailyReports.listDailyReports(), []);
  assert.equal(dailyReports.getLatestDailyReport(), null);
  assert.equal(dailyReports.hasReportForToday(), false);
});

test('saveDailyReport persists and getDailyReport retrieves it by date', () => {
  const saved = dailyReports.saveDailyReport(makeReport('2026-01-01'));
  assert.deepEqual(dailyReports.getDailyReport('2026-01-01'), saved);
  assert.equal(dailyReports.getDailyReport('2026-01-02'), null);
});

test('saving a report for today makes hasReportForToday true', () => {
  dailyReports.saveDailyReport(makeReport(dailyReports.todayKey()));
  assert.equal(dailyReports.hasReportForToday(), true);
});

test('listDailyReports sorts newest first and getLatestDailyReport matches the top of that list', () => {
  dailyReports.saveDailyReport(makeReport('2026-01-03'));
  dailyReports.saveDailyReport(makeReport('2026-01-02'));

  const list = dailyReports.listDailyReports();
  const dates = list.map((r) => r.date);
  assert.deepEqual([...dates].sort().reverse(), dates);
  assert.deepEqual(dailyReports.getLatestDailyReport(), list[0]);
});

test('saveDailyReport for an existing date overwrites rather than duplicating', () => {
  dailyReports.saveDailyReport(makeReport('2026-01-01', { leadership: { reply: 'first run', trace: [] } }));
  const before = dailyReports.listDailyReports().length;

  dailyReports.saveDailyReport(makeReport('2026-01-01', { leadership: { reply: 'second run', trace: [] } }));

  assert.equal(dailyReports.listDailyReports().length, before);
  assert.equal(dailyReports.getDailyReport('2026-01-01').leadership.reply, 'second run');
});
