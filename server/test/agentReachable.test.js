// Selling to agents, and the founder controls that came with the veto.
//
// A buyer's first contact with an API in 2026 is increasingly their own
// assistant trying to call it. An MCP endpoint is how the product becomes
// reachable that way — but only if the team knows the URL exists and says so,
// which is the whole point of putting it on the venture record and into the
// outreach context rather than leaving it in a chat log.
//
// The discount floor is the other half of review.js: the veto is arithmetic,
// and this is how the founder moves the number it compares against.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let commands;
let ventures;
let context;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-reachable-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  commands = await import('../channels/founderCommands.js');
  ventures = await import('../finance/ventures.js');
  context = await import('../finance/context.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
});

// The founder's words in, the company's reply out — the same two steps the
// WhatsApp channel takes, so a command that parses but does not run is caught.
async function run(text) {
  const command = commands.parseFounderCommand(text);
  assert.ok(command, `"${text}" did not parse as a command`);
  return commands.runFounderCommand(command);
}

function newVenture() {
  const venture = ventures.createVenture({ title: 'CircadianAPI', milestones: ['ship'] });
  ventures.setPricing(venture.id, { currency: 'EUR', floorMonthly: 149, perUnit: 0.02, unit: 'page' });
  return venture;
}

// --- The endpoint ------------------------------------------------------------

test('MCP records an endpoint on the venture', async () => {
  const venture = newVenture();
  const reply = await run(`MCP ${venture.id} https://api.circadian.example/mcp`);
  assert.match(reply, /recorded/i);
  assert.equal(ventures.getVenture(venture.id).mcp.url, 'https://api.circadian.example/mcp');
});

test('MCP CLEAR removes it', async () => {
  const venture = newVenture();
  await run(`MCP ${venture.id} https://api.circadian.example/mcp`);
  await run(`MCP CLEAR ${venture.id}`);
  assert.ok(!ventures.getVenture(venture.id).mcp, 'no endpoint left on the record');
});

// http:// would be a live endpoint quoted to a customer over an unencrypted
// connection. Nothing in this app should guess a URL, and nothing should
// record one it would be embarrassing to cite.
test('an MCP endpoint has to be https', () => {
  const venture = newVenture();
  assert.throws(() => ventures.setMcpEndpoint(venture.id, 'http://api.example/mcp'), /https/);
});

test('the team is told where the endpoint is, next to the price', () => {
  const venture = newVenture();
  ventures.linkOutreachScope(venture.id, { domains: ['acme.example'] });
  ventures.setOutreachEnabled(venture.id, true);
  ventures.setMcpEndpoint(venture.id, 'https://api.circadian.example/mcp');

  const text = context.buildOutreachContext();
  assert.match(text, /https:\/\/api\.circadian\.example\/mcp/);
  assert.match(text, /agent/i, 'and says what it is for');
});

test('a venture with no endpoint says nothing about one', () => {
  const venture = newVenture();
  ventures.linkOutreachScope(venture.id, { domains: ['acme.example'] });
  ventures.setOutreachEnabled(venture.id, true);
  assert.doesNotMatch(context.buildOutreachContext(), /MCP endpoint/);
});

// --- The discount floor --------------------------------------------------------

test('DISCOUNT sets a floor the team may quote down to', async () => {
  const venture = newVenture();
  const reply = await run(`DISCOUNT ${venture.id} 99`);
  assert.match(reply, /99/);
  assert.equal(ventures.getVenture(venture.id).discount.approvedFloor, 99);
});

test('DISCOUNT CLEAR puts it back to list price', async () => {
  const venture = newVenture();
  await run(`DISCOUNT ${venture.id} 99`);
  const reply = await run(`DISCOUNT CLEAR ${venture.id}`);
  assert.match(reply, /149/, 'and names the list price it went back to');
  assert.ok(!ventures.getVenture(venture.id).discount, 'no floor left on the record');
});

test('a negative floor is refused', () => {
  const venture = newVenture();
  assert.throws(() => ventures.setDiscountFloor(venture.id, -5), />= 0/);
});

// The commands are parsed from the founder's own words, so the boundary
// matters more than the happy path: a sentence about discounts is not a
// discount.
test('talking about discounts is not a command', () => {
  for (const text of [
    'should we offer a discount to acme',
    'the mcp thing you mentioned',
    'discount clear as mud',
  ]) {
    assert.equal(commands.parseFounderCommand(text), null, `"${text}" should not parse`);
  }
});

test('both commands need a real venture id', () => {
  assert.equal(commands.parseFounderCommand('MCP acme https://a.example/mcp'), null);
  assert.equal(commands.parseFounderCommand('DISCOUNT acme 99'), null);
});

test('the help text lists both', () => {
  assert.match(commands.__helpForTests, /MCP <ventureId>/);
  assert.match(commands.__helpForTests, /DISCOUNT <ventureId>/);
});
