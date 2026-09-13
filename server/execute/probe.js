// Does the thing we shipped actually answer?
//
// The team could already commit code, dispatch CI and read a failure summary
// off a red check. None of that answers the question a customer asks. CI green
// means the tests passed inside a runner on GitHub's infrastructure; it says
// nothing about whether the deployed service is running, whether the container
// booted, whether the environment variables are set, or whether the route the
// docs promise exists. For a company whose entire product is an HTTP API,
// that gap is the difference between shipping something and reporting that you
// shipped it — which is the exact failure `reporting-status` exists for, left
// structurally unfixable because no tool could close it.
//
// ## Why the agent cannot choose the host
//
// An outbound HTTP GET with an agent-supplied URL is a server-side request
// forgery primitive: the agent could reach the platform's metadata endpoint,
// anything on localhost, or any host inside the network this server happens to
// sit in. So the origin is founder-set, stored on the venture, and the agent
// supplies only a path. Same shape as every other scope in this app — the
// founder grants a narrow capability and the data layer enforces it, never the
// prompt.
//
// The host checks below are belt and braces on top of that: the founder is not
// an attacker, but a typo'd or copy-pasted URL should fail at the boundary
// rather than become a request to something internal. They run both when the
// URL is set and again before every probe, because a stored value can predate
// a rule that got stricter.
//
// ## GET only
//
// A probe answers "is it up, and what does it say". Adding a method and a body
// would make this a general HTTP client pointed at arbitrary paths, and the
// venture's own test suite is the right place to exercise writes.

const DEFAULT_TIMEOUT_MS = 10_000;
// Enough to see an error payload or a small JSON response. A probe that
// streamed a large body would turn a health check into a bandwidth bill.
const MAX_BODY_CHARS = 2_000;

// Hostnames that must never be probed, whatever is stored. Cloud metadata
// services are the reason this list exists at all: 169.254.169.254 serves
// credentials to anything that asks, over plain HTTP, with no authentication.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain'];

/**
 * Checks a URL is a public https origin this server may fetch, and returns its
 * normalised origin. Throws with the reason otherwise — the founder is setting
 * this from a phone, and "that is not a URL" is useless next to "that is
 * http, and a health check over http would send the path in plaintext".
 */
export function assertProbeableUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return fail(`"${raw}" is not a URL. It needs the scheme too, like https://circadian-api.up.railway.app`);
  }

  if (url.protocol !== 'https:') {
    return fail(`Only https can be probed, and that is ${url.protocol.replace(':', '')}. A deployed service on Railway, Vercel or Fly already has https.`);
  }
  if (url.username || url.password) {
    return fail('Leave credentials out of the URL — a probe does not authenticate, and a URL with a password in it ends up in a log.');
  }

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return fail(`"${host}" is not a public address. A health check has to reach the service the way a customer does, from outside.`);
  }
  // An IP literal, v4 or v6, is refused outright rather than range-checked.
  // Getting private-range arithmetic right is fiddly and a deployed product
  // has a hostname; refusing the whole category is both safer and simpler to
  // explain.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || url.hostname.startsWith('[')) {
    return fail(`"${host}" is a raw IP address. Use the hostname the service is actually served on.`);
  }
  // A single-label host ("api", "backend") is a container or service name on
  // an internal network, never a public one.
  if (!host.includes('.')) {
    return fail(`"${host}" has no domain, so it can only be an internal name. Use the public hostname.`);
  }

  return url.origin;
}

function fail(message) {
  throw new Error(message);
}

/**
 * One GET against a founder-approved origin.
 *
 * Returns what happened in both cases rather than throwing on a non-2xx: a 500
 * from the service is the probe working correctly and is the single most useful
 * thing it can report. Only a failure to reach the host at all throws.
 *
 * @param {{origin: string, path?: string, timeoutMs?: number}} opts
 */
export async function probeEndpoint({ origin, path = '/', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = assertProbeableUrl(origin);
  // Resolved against the approved origin, so "../", a leading "//host" or an
  // absolute URL cannot move the request to a different host: anything that
  // resolves away from the grant is refused rather than silently followed.
  const target = new URL(String(path || '/'), `${base}/`);
  if (target.origin !== base) {
    fail(`"${path}" points outside ${base}. Pass a path on this venture's own service, not a full URL.`);
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

  try {
    const response = await fetch(target.toString(), {
      method: 'GET',
      // A redirect is reported, never followed. Following one could leave the
      // approved origin, and "this endpoint 301s somewhere else" is usually
      // the finding rather than a detail to paper over.
      redirect: 'manual',
      headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8', 'User-Agent': 'Jarvis-healthcheck/1' },
      signal: controller.signal,
    });

    const text = await response.text().catch(() => '');
    return {
      url: target.toString(),
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      contentType: response.headers.get('content-type') || '',
      location: response.headers.get('location') || '',
      ms: Date.now() - startedAt,
      body: text.slice(0, MAX_BODY_CHARS),
      truncated: text.length > MAX_BODY_CHARS,
    };
  } catch (err) {
    // No response at all. Distinguished from a bad response because the two
    // mean completely different things: nothing is listening, versus something
    // is listening and is broken.
    const reason = err.name === 'AbortError' ? `no response within ${timeoutMs}ms` : err.message;
    return {
      url: target.toString(),
      status: 0,
      ok: false,
      unreachable: true,
      ms: Date.now() - startedAt,
      reason,
    };
  } finally {
    clearTimeout(timer);
  }
}
