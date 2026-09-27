// Circadian, served from this service at /circadian.
//
// Circadian is a Python app (FastAPI) and Jarvis is a Node one. It runs here
// rather than as its own Railway service because a second service is a second
// thing for the founder to create, configure and pay for from a phone, and the
// first attempt at that never got deployed at all. So this process starts
// Circadian as a child on a local port and forwards /circadian/* to it.
//
// Three details carry the design:
//
// - The proxy is mounted before express.json() and before requireAccess.
//   json() would consume the request body before it could be forwarded, and
//   Circadian is a consumer app: travellers never have the Jarvis token.
// - The prefix is stripped on the way in and announced in X-Forwarded-Prefix,
//   which is how Circadian builds its WHOOP callback URL and its redirects.
//   A client-supplied X-Forwarded-Prefix is overwritten, never passed on.
// - The child gets only the variables it needs (its own, WHOOP, push, PostHog). It is our own code, but it
//   has no reason to hold the Anthropic, Twilio or GitHub keys, and a process
//   that doesn't hold a secret can't leak it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CIRCADIAN_PREFIX = '/circadian';
export const CIRCADIAN_DIR = path.join(__dirname, '..', 'ventures', 'circadian');
// The Dockerfile installs Circadian's dependencies into this virtualenv.
const IMAGE_PYTHON = '/opt/circadian/bin/python';

// A crash is restarted, but one that crashes on every start (a missing
// dependency, a syntax error) is given up on rather than retried for ever,
// which would bury every other line in the deploy log.
const MAX_QUICK_FAILURES = 5;
const QUICK_FAILURE_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

// What the child inherits. Proxy and certificate variables are here because
// WHOOP and the push services are reached over HTTPS from inside it.
const PASSED_ENV = /^(CIRCADIAN_|WHOOP_|VAPID_|POSTHOG_)|^(PATH|HOME|LANG|LC_ALL|TZ|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/;

const state = {
  child: null,
  running: false,
  gaveUp: false,
  off: false,
  lastError: '',
  quickFailures: 0,
  stopping: false,
};

export function circadianPort() {
  return Number(process.env.CIRCADIAN_PORT) || 8001;
}

function pythonPath() {
  if (process.env.CIRCADIAN_PYTHON) return process.env.CIRCADIAN_PYTHON;
  return fs.existsSync(IMAGE_PYTHON) ? IMAGE_PYTHON : 'python3';
}

/**
 * Circadian's data directory: its own folder inside Jarvis's volume, so the
 * volume the founder already mounted keeps reminders and WHOOP connections
 * across redeploys too. CIRCADIAN_DATA_DIR overrides it.
 */
export function circadianDataDir(env = process.env) {
  if ((env.CIRCADIAN_DATA_DIR || '').trim()) return env.CIRCADIAN_DATA_DIR;
  const jarvisData = (env.JARVIS_DATA_DIR || '').trim()
    ? path.resolve(env.JARVIS_DATA_DIR)
    : path.join(__dirname, 'data');
  return path.join(jarvisData, 'circadian');
}

export function childEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (PASSED_ENV.test(key)) out[key] = value;
  }
  out.CIRCADIAN_DATA_DIR = circadianDataDir(env);
  out.PYTHONUNBUFFERED = '1';
  return out;
}

/**
 * Starts Circadian and keeps it running. Safe to call once at boot; does
 * nothing when the code isn't bundled or CIRCADIAN=off.
 */
export function startCircadian({ spawnFn = spawn } = {}) {
  if ((process.env.CIRCADIAN || '').toLowerCase() === 'off') {
    state.lastError = 'Turned off with CIRCADIAN=off.';
    state.off = true;
    return;
  }
  if (!fs.existsSync(path.join(CIRCADIAN_DIR, 'src', 'app.py'))) {
    state.lastError = `Not bundled: ${CIRCADIAN_DIR} is missing.`;
    console.error(`Circadian: ${state.lastError}`);
    return;
  }
  launch(spawnFn);
  process.once('exit', stopCircadian);
  // A SIGTERM or Ctrl-C ends Node without an 'exit' event, which left
  // Circadian running on its own and holding its port, so the next Jarvis
  // could not start one. Only taken over when nothing else handles the
  // signal, so a graceful shutdown added elsewhere is not cut short.
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    if (process.listenerCount(signal) > 0) continue;
    process.once(signal, () => {
      stopCircadian();
      process.exit(code);
    });
  }
}

export function stopCircadian() {
  state.stopping = true;
  state.child?.kill();
}

function launch(spawnFn) {
  const python = pythonPath();
  const startedAt = Date.now();
  const child = spawnFn(
    python,
    ['-m', 'uvicorn', 'src.app:app', '--host', '127.0.0.1', '--port', String(circadianPort())],
    { cwd: CIRCADIAN_DIR, env: childEnv(), stdio: ['ignore', 'inherit', 'inherit'] }
  );
  state.child = child;
  state.running = true;

  child.on('error', (err) => {
    // ENOENT: no Python at that path. Retrying cannot fix it.
    state.running = false;
    state.gaveUp = true;
    state.lastError = `Could not start ${python}: ${err.message}. Set CIRCADIAN_PYTHON to a Python with Circadian's requirements installed.`;
    console.error(`Circadian: ${state.lastError}`);
  });

  child.on('exit', (code, signal) => {
    state.running = false;
    if (state.stopping || state.gaveUp) return;
    const quick = Date.now() - startedAt < QUICK_FAILURE_MS;
    state.quickFailures = quick ? state.quickFailures + 1 : 0;
    state.lastError = `Exited (${signal || `code ${code}`}).`;
    if (state.quickFailures >= MAX_QUICK_FAILURES) {
      state.gaveUp = true;
      state.lastError = `Failed to start ${MAX_QUICK_FAILURES} times in a row; the reason is in the lines above this one in the deploy log.`;
      console.error(`Circadian: ${state.lastError}`);
      return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** state.quickFailures);
    console.error(`Circadian: ${state.lastError} Restarting in ${delay / 1000}s.`);
    setTimeout(() => launch(spawnFn), delay).unref();
  });
}

/**
 * The same check Circadian makes at startup (whoop.reachability), from this
 * process. Cloudflare in front of WHOOP blocked the live token exchange from
 * the Python child three times without naming a rule. Two answers tell the
 * causes apart: Node refused too means this server's address is blocked and
 * only WHOOP can lift it; Node through while Python is refused means the
 * client, and WHOOP calls can move here. The code sent is one WHOOP cannot
 * know, so the only correct answer is its JSON error.
 */
export async function probeWhoop({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const id = (env.WHOOP_CLIENT_ID || '').trim();
  const secret = (env.WHOOP_CLIENT_SECRET || '').trim();
  if (!id || !secret) return null;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'reachability-check',
    redirect_uri: 'https://example.invalid/whoop/callback',
    client_id: id,
    client_secret: secret,
  });
  let res;
  try {
    res = await fetchImpl('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'Circadian/1.0' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.log(`Circadian: WHOOP could not be reached from Node (${err.message}).`);
    return { status: 0, reachable: false };
  }
  let error;
  try {
    error = JSON.parse(await res.text()).error;
  } catch {
    error = undefined;
  }
  if (error) {
    console.log(`Circadian: WHOOP's OAuth server is reachable from Node (it answered HTTP ${res.status} ${error} to a check).`);
    return { status: res.status, reachable: true };
  }
  console.log(`Circadian: WHOOP is NOT reachable from Node either: HTTP ${res.status} from ${res.headers.get('server') || '?'}`
    + ` (cf-ray ${res.headers.get('cf-ray') || '-'}). Both processes refused means this server's address is blocked; only WHOOP can lift that.`);
  return { status: res.status, reachable: false };
}

export function describeCircadian() {
  if (state.running) {
    return { configured: true, ok: true, detail: `Running, served at ${CIRCADIAN_PREFIX}/. Data in ${circadianDataDir()}.` };
  }
  // Switched off on purpose is "not set", not a failure to colour red.
  return { configured: false, ok: state.off ? null : false, detail: state.lastError || 'Not started.' };
}

// Connection-level headers belong to one hop and must not be forwarded.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];

/**
 * Express middleware, mounted with app.use(CIRCADIAN_PREFIX, ...), that
 * forwards the request to Circadian. `target` is for tests.
 */
export function circadianProxy({ target = () => ({ host: '127.0.0.1', port: circadianPort() }) } = {}) {
  return (req, res) => {
    // "/circadian" without the slash: relative URLs in the page would resolve
    // against "/" and miss the app entirely.
    if (req.originalUrl.split('?')[0] === CIRCADIAN_PREFIX) {
      const query = req.originalUrl.slice(CIRCADIAN_PREFIX.length);
      return res.redirect(301, `${CIRCADIAN_PREFIX}/${query}`);
    }

    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    const remote = req.socket.remoteAddress || '';
    // Railway already put the traveller's address first; keep it first, since
    // Circadian rate-limits on it.
    headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${remote}` : remote;
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
    headers['x-forwarded-prefix'] = CIRCADIAN_PREFIX;

    const { host, port } = target();
    const upstream = http.request({ host, port, method: req.method, path: req.url, headers }, (upRes) => {
      const outHeaders = { ...upRes.headers };
      for (const name of HOP_BY_HOP) delete outHeaders[name];
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
    });

    upstream.on('error', (err) => {
      if (res.headersSent) return res.destroy(err);
      res.status(503).set('Retry-After', '5').json({
        error: 'Circadian is not running right now.',
        detail: describeCircadian().detail,
      });
    });
    // The traveller hung up: stop the upstream request too.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  };
}
