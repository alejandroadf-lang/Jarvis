// The view link is the one credential that travels through chat. graph.test.js
// pins that a fresh token verifies and a tampered one does not; this pins the
// two properties the module's comment rests on: it expires, and it is derived
// from the app token, so rotating the app token kills every link in the wild.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let viewToken;
let savedEnv;

before(async () => {
  savedEnv = { ...process.env };
  viewToken = await import('../viewToken.js');
});

after(() => {
  process.env = savedEnv;
});

beforeEach(() => {
  process.env.APP_ACCESS_TOKEN = 'founder-secret';
  delete process.env.VIEW_TOKEN_TTL_MINUTES;
  delete process.env.PUBLIC_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
});

test('a view link lasts thirty minutes by default, and not a second longer', () => {
  const now = 1_800_000_000_000;
  const token = viewToken.mintViewToken({ now });
  assert.equal(viewToken.verifyViewToken(token, { now: now + 30 * 60 * 1000 }).valid, true);
  assert.deepEqual(viewToken.verifyViewToken(token, { now: now + 30 * 60 * 1000 + 1 }), { valid: false, reason: 'expired' });
});

test('the lifetime follows VIEW_TOKEN_TTL_MINUTES', () => {
  process.env.VIEW_TOKEN_TTL_MINUTES = '5';
  const now = 1_800_000_000_000;
  const token = viewToken.mintViewToken({ now });
  assert.equal(viewToken.verifyViewToken(token, { now: now + 5 * 60 * 1000 }).valid, true);
  assert.equal(viewToken.verifyViewToken(token, { now: now + 6 * 60 * 1000 }).reason, 'expired');
});

test('rotating the app token invalidates every link already sent', () => {
  const token = viewToken.mintViewToken();
  process.env.APP_ACCESS_TOKEN = 'rotated-secret';
  assert.equal(viewToken.verifyViewToken(token).reason, 'bad signature');
});

test('a link cannot be extended by editing its expiry', () => {
  const token = viewToken.mintViewToken({ now: 1_800_000_000_000 });
  const [, signature] = token.split('.');
  const later = Buffer.from(String(9_999_999_999_999)).toString('base64url');
  assert.equal(viewToken.verifyViewToken(`${later}.${signature}`).reason, 'bad signature');
});

test('the link is not the app token and does not contain it', () => {
  const token = viewToken.mintViewToken();
  assert.notEqual(token, 'founder-secret');
  assert.equal(token.includes('founder-secret'), false);
  assert.equal(Buffer.from(token.split('.')[0], 'base64url').toString().includes('founder'), false);
});

test('the link goes in the fragment, under PUBLIC_URL or the Railway domain', () => {
  assert.match(viewToken.graphLink(), /^\/graph#t=[^.]+\.[^.]+$/);
  process.env.RAILWAY_PUBLIC_DOMAIN = 'jarvis-production.up.railway.app';
  assert.match(viewToken.graphLink(), /^https:\/\/jarvis-production\.up\.railway\.app\/graph#t=/);
  process.env.PUBLIC_URL = 'https://jarvis.example.com//';
  assert.match(viewToken.graphLink(), /^https:\/\/jarvis\.example\.com\/graph#t=/, 'PUBLIC_URL wins, trailing slashes dropped');
});

test('with no app token set, nothing is protected and the answer says so', () => {
  delete process.env.APP_ACCESS_TOKEN;
  const result = viewToken.verifyViewToken('anything');
  assert.equal(result.valid, true);
  assert.match(result.reason, /no access token set/);
});
