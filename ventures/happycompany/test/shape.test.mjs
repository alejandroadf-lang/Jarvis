import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventShape, shapeLoggingOn } from '../src/lib/shape.mjs';

const event = {
  eventType: 'avi:jira:mentioned:issue',
  atlassianId: '557058:secret-account',
  issue: { id: '10001', key: 'OPS-42', fields: { summary: 'Payroll bug for Maria', updated: '2026-09-28T23:10:00.000+0700' } },
  mentionedAccountIds: ['557058:someone-else'],
  changelog: { items: [{ field: 'duedate', from: '2026-10-01', to: '2026-10-08' }] },
  comment: null,
};

test('the shape names every path and type and contains no value', () => {
  const lines = eventShape(event);
  assert.deepEqual(lines, [
    'atlassianId: string',
    'changelog.items: array(1)',
    'changelog.items[0].field: string',
    'changelog.items[0].from: string',
    'changelog.items[0].to: string',
    'comment: null',
    'eventType: string',
    'issue.fields.summary: string',
    'issue.fields.updated: string',
    'issue.id: string',
    'issue.key: string',
    'mentionedAccountIds: array(1)',
    'mentionedAccountIds[0]: string',
  ]);
  const text = lines.join('\n');
  for (const secret of ['557058', 'OPS-42', 'Maria', 'Payroll', '2026', 'duedate', 'mentioned:issue']) {
    assert.ok(!text.includes(secret), secret);
  }
});

test('deep or huge events are cut off rather than logged whole', () => {
  let deep = { v: 1 };
  for (let i = 0; i < 20; i++) deep = { d: deep };
  assert.ok(eventShape(deep).length <= 1);
  const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
  assert.equal(eventShape(wide).length, 200);
});

test('it is off unless the environment variable is exactly "1"', () => {
  assert.equal(shapeLoggingOn({}), false);
  assert.equal(shapeLoggingOn({ HAPPYCOMPANY_LOG_SHAPES: 'true' }), false);
  assert.equal(shapeLoggingOn({ HAPPYCOMPANY_LOG_SHAPES: '1' }), true);
});
