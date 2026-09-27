// Circadian runs inside this service and is reached through /circadian.
//
// What is pinned here is what a traveller's phone depends on and what would
// fail quietly: the body of a POST arriving intact (express.json() ahead of
// the proxy would swallow it), the prefix being stripped and announced so
// WHOOP calls back to the right URL, a spoofed prefix being overwritten, the
// traveller's address staying first for Circadian's rate limit, and a clear
// 503 instead of a hung request when Circadian is down. Plus the child's
// environment: it gets its own variables and not Jarvis's keys.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import express from 'express';
import {
  CIRCADIAN_PREFIX,
  circadianProxy,
  childEnv,
  circadianDataDir,
  startCircadian,
  describeCircadian,
} from '../circadian.js';

let upstream;
let upstreamPort;
let seen;
let jarvis;
let base;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(201, { 'content-type': 'application/json', 'x-from': 'circadian' });
      res.end(JSON.stringify({ echoed: body }));
    });
  });
  upstreamPort = await listen(upstream);

  // Mounted exactly as index.js mounts it: first, with the JSON parser after.
  const app = express();
  app.use('/down' + CIRCADIAN_PREFIX, circadianProxy({ target: () => ({ host: '127.0.0.1', port: 1 }) }));
  app.use(CIRCADIAN_PREFIX, circadianProxy({ target: () => ({ host: '127.0.0.1', port: upstreamPort }) }));
  app.use(express.json());
  app.get('/', (_req, res) => res.send('jarvis'));
  jarvis = http.createServer(app);
  base = `http://127.0.0.1:${await listen(jarvis)}`;
});

after(() => {
  upstream.close();
  jarvis.close();
});

test('/circadian without a slash redirects, keeping the query, so relative URLs in the page resolve', async () => {
  const res = await fetch(`${base}/circadian?whoop=connected`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/circadian/?whoop=connected');
});

test('a POST reaches Circadian with its body, the prefix stripped, and the response comes back as sent', async () => {
  const trip = JSON.stringify({ departure: '2026-10-10T19:00', departure_tz: 'Europe/London' });
  const res = await fetch(`${base}/circadian/app/plan?x=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: trip,
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('x-from'), 'circadian');
  assert.deepEqual(await res.json(), { echoed: trip });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/app/plan?x=1');
  assert.equal(seen.body, trip);
});

test('the prefix is announced, and a prefix the caller sent is overwritten rather than trusted', async () => {
  await fetch(`${base}/circadian/whoop/connect`, {
    headers: { 'x-forwarded-prefix': '//evil.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'jarvis.example' },
  });
  assert.equal(seen.headers['x-forwarded-prefix'], '/circadian');
  // Railway's own values pass through: they are what WHOOP's callback URL is built from.
  assert.equal(seen.headers['x-forwarded-proto'], 'https');
  assert.equal(seen.headers['x-forwarded-host'], 'jarvis.example');
});

test("the traveller's address stays first, since Circadian rate-limits on it", async () => {
  await fetch(`${base}/circadian/`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.match(seen.headers['x-forwarded-for'], /^203\.0\.113\.9, /);
});

test('paths outside /circadian stay with Jarvis', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(await res.text(), 'jarvis');
  seen = null;
  const other = await fetch(`${base}/circadianx`);
  assert.equal(other.status, 404);
  assert.equal(seen, null, 'a path that merely starts with the word must not reach Circadian');
});

test('when Circadian is not running the answer is a 503 that says so, not a hung request', async () => {
  const res = await fetch(`${base}/down/circadian/app/push/key`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /Circadian is not running/);
});

test("the child gets Circadian's variables and none of Jarvis's keys", () => {
  const env = childEnv({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    TWILIO_AUTH_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    WHOOP_CLIENT_ID: 'cid',
    WHOOP_CLIENT_SECRET: 'cs',
    VAPID_SUBJECT: 'mailto:x@example.com',
    JARVIS_DATA_DIR: '/data',
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.TWILIO_AUTH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.WHOOP_CLIENT_ID, 'cid');
  assert.equal(env.WHOOP_CLIENT_SECRET, 'cs');
  assert.equal(env.VAPID_SUBJECT, 'mailto:x@example.com');
  assert.equal(env.PATH, '/usr/bin');
  // Inside the volume Jarvis already has, so reminders survive a redeploy.
  assert.equal(env.CIRCADIAN_DATA_DIR, '/data/circadian');
});

test('CIRCADIAN_DATA_DIR overrides the default', () => {
  assert.equal(circadianDataDir({ CIRCADIAN_DATA_DIR: '/elsewhere', JARVIS_DATA_DIR: '/data' }), '/elsewhere');
});

test('a Circadian that dies on every start is given up on, and the status says so', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const logged = mock.method(console, 'error', () => {});
  try {
    let spawns = 0;
    const spawnFn = () => {
      spawns += 1;
      const child = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    };
    startCircadian({ spawnFn });
    return (async () => {
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        mock.timers.tick(60_000);
      }
      assert.equal(spawns, 5);
      const status = describeCircadian();
      assert.equal(status.ok, false);
      assert.match(status.detail, /Failed to start 5 times/);
    })().finally(() => {
      mock.timers.reset();
      logged.mock.restore();
    });
  } catch (err) {
    mock.timers.reset();
    logged.mock.restore();
    throw err;
  }
});

// Found by running it: a SIGTERM ended Jarvis without an 'exit' event and left
// Circadian running, holding its port, so the next Jarvis could not start one.
test('stopping Jarvis with SIGTERM stops Circadian too', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-circadian-'));
  const pidFile = path.join(dir, 'child.pid');
  // Stands in for Python: records its pid and waits to be killed.
  const fakePython = path.join(dir, 'python');
  fs.writeFileSync(fakePython, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`, { mode: 0o755 });

  const moduleUrl = new URL('../circadian.js', import.meta.url).href;
  const jarvis = spawn(process.execPath, ['--input-type=module', '-e',
    `import { startCircadian } from ${JSON.stringify(moduleUrl)}; startCircadian(); setInterval(() => {}, 1000);`], {
    env: { ...process.env, CIRCADIAN_PYTHON: fakePython, CIRCADIAN_DATA_DIR: dir },
    stdio: 'ignore',
  });

  let childPid;
  for (let i = 0; i < 50 && !childPid; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (fs.existsSync(pidFile)) childPid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || undefined;
  }
  assert.ok(childPid, 'the stand-in Circadian started');

  const exited = new Promise((resolve) => jarvis.once('exit', resolve));
  jarvis.kill('SIGTERM');
  await exited;

  let alive = true;
  for (let i = 0; i < 30 && alive; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { process.kill(childPid, 0); } catch { alive = false; }
  }
  if (alive) process.kill(childPid, 'SIGKILL');
  assert.equal(alive, false, 'Circadian outlived Jarvis');
  fs.rmSync(dir, { recursive: true, force: true });
});
