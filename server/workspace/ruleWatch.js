// A silent change to a rule the company depends on is the risk nobody sees.
//
// The rules register (rulesRegister.js) lists, for each outside rule, the pages
// it comes from: WHOOP's API terms, Atlassian's marketplace policies, and so on.
// A provider that edits those pages does not tell anyone, and the one that
// matters most (WHOOP's terms, which may forbid what Circadian's API sells)
// could change any week. So once a day the server fetches each source page,
// keeps its text, and when the text changes it says so: a note for the founder,
// the rule page's status set to `source-changed`, and one WhatsApp message.
// No model call and no vendor: this is a page fetched and compared.
//
// Three things about it are deliberate:
//
// 1. The URLs come from pages agents may edit, so fetching them is a way to
//    make this server request an address of an agent's choosing. It fetches
//    only public https addresses: no IP literals, no localhost, no ports, every
//    resolved address checked as public, every redirect re-checked. One gap
//    remains that plain fetch cannot close (a name that resolves differently on
//    the second lookup), which is why the body is only hashed and diffed and
//    never returned to anyone as it came.
// 2. What a page says is text from the outside. The change note is written to
//    the quarantine folder, with each line screened by the write gate, so
//    nothing an agent reads or compiles ever rests on it. The founder reads it.
// 3. The first look at a page is a baseline, not an alert.

import dns from 'node:dns/promises';
import net from 'node:net';
import { readJson, writeJson } from '../store.js';
import { setFields, serializeNote } from './frontmatter.js';
import { checkVaultText } from './writeGate.js';
import { writeVaultNote, publishServerPage, noteName, QUARANTINE_FOLDER } from './vault.js';
import { allowedNumbers, sendWhatsAppMessage, isWhatsAppConfigured } from '../channels/whatsapp.js';

const FILE = 'rule-watch.json';
const MAX_URLS = 12;
const MAX_URLS_PER_PAGE = 4;
const MAX_BYTES = 1_500_000;
const MAX_LINES = 600;
const TIMEOUT_MS = 10_000;
const MAX_HOPS = 3;

/** True only for an address on the public internet. */
export function isPublicAddress(address) {
  const v = net.isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return false;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return false;
    return true;
  }
  return false;
}

function checkUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('not a URL');
  }
  if (u.protocol !== 'https:') throw new Error('only https pages are fetched');
  if (u.port && u.port !== '443') throw new Error('only the standard port is used');
  if (u.username || u.password) throw new Error('credentials in a URL are refused');
  const host = u.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) throw new Error('an IP address is not a page');
  if (host === 'localhost' || !host.includes('.') || /\.(local|internal|localhost|lan)$/.test(host)) throw new Error('not a public host');
  return u;
}

/** Fetches a public https page as text, or throws with the reason it would not. */
export async function safeFetchText(url, { fetchImpl = fetch, lookup = (h) => dns.lookup(h, { all: true }) } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const u = checkUrl(current);
    const addresses = await lookup(u.hostname);
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) throw new Error('the host does not resolve to a public address');
    const res = await fetchImpl(u.href, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'jarvis-rule-watch', Accept: 'text/html,text/plain' } });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error(`redirect ${res.status} with no location`);
      current = new URL(next, u.href).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '');
    if (!/(text\/|json|xml)/i.test(type)) throw new Error(`not a text page (${type || 'no content type'})`);
    const text = await res.text();
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  }
  throw new Error('too many redirects');
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** A page's readable lines, without markup, scripts or styling. Pure. */
export function extractLines(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|ul|ol|table)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 4)
    .slice(0, MAX_LINES);
}

const norm = (l) => l.toLowerCase();

/** Lines added and removed between two versions of a page. Pure. */
export function diffLines(before, after) {
  const was = new Set(before.map(norm));
  const is = new Set(after.map(norm));
  return { added: after.filter((l) => !was.has(norm(l))), removed: before.filter((l) => !is.has(norm(l))) };
}

function sourcesOf(note) {
  const section = note.body.match(/## Sources\s*\n([\s\S]*?)(\n## |$)/);
  if (!section) return [];
  return [...section[1].matchAll(/^\s*-\s*(https:\/\/\S+)/gim)].map((m) => m[1]).slice(0, MAX_URLS_PER_PAGE);
}

async function notifyFounder(text) {
  if (!isWhatsAppConfigured()) return false;
  let delivered = false;
  for (const number of allowedNumbers()) {
    try {
      await sendWhatsAppMessage(number, text);
      delivered = true;
    } catch (err) {
      console.error(`Rule watch: could not message ${number}: ${err.message}`);
    }
  }
  return delivered;
}

const clip = (lines, n = 10) => lines.slice(0, n).map((l) => `- ${l.slice(0, 220)}`).join('\n') || '_None._';
const stem = (p) => p.split('/').pop().replace(/\.md$/, '');

/**
 * Looks at every source page of every rule, once. Returns what it found; never
 * throws. `notes` is the vault's notes as the index loads them.
 */
export async function watchRules({ notes, now = new Date(), fetchImpl, lookup, notify = notifyFounder } = {}) {
  const found = { checked: 0, changed: [], failed: [] };
  const state = readJson(FILE, { urls: {} });
  const today = now.toISOString().slice(0, 10);

  const targets = [];
  for (const n of notes.filter((x) => x.path.startsWith('Company/Rules/') && x.fm.type === 'rule')) {
    for (const url of sourcesOf(n)) targets.push({ note: n, url });
  }

  for (const { note, url } of targets.slice(0, MAX_URLS)) {
    const seen = state.urls[url] || { lines: null, failures: 0 };
    let lines;
    try {
      lines = extractLines(await safeFetchText(url, { fetchImpl, lookup }));
      if (!lines.length) throw new Error('the page had no readable text');
    } catch (err) {
      seen.failures = (seen.failures || 0) + 1;
      state.urls[url] = seen;
      if (seen.failures === 3) found.failed.push({ url, reason: err.message });
      continue;
    }
    found.checked += 1;
    seen.failures = 0;
    seen.checkedAt = now.toISOString();
    const previous = seen.lines;
    seen.lines = lines;
    state.urls[url] = seen;
    if (!previous) continue; // the first look is a baseline

    const { added, removed } = diffLines(previous, lines);
    if (!added.length && !removed.length) continue;

    // Text from a web page is untrusted: each line goes through the gate, and
    // the note lands where nothing the team reads or compiles will rest on it.
    const safe = (list) => list.filter((l) => !checkVaultText(l));
    const path = `${QUARANTINE_FOLDER}/${today} Rule changed — ${noteName(stem(note.path))}.md`;
    const body = `\n# ${stem(note.path)}: the source page changed\n\nPage: ${url}\n\nThis is what the page now says differently. It is text from the outside, kept apart on purpose: read the page itself, then update the rule and set its status to \`reviewed\`.\n\n## Added\n\n${clip(safe(added))}\n\n## Removed\n\n${clip(safe(removed))}\n`;
    const written = await publishServerPage(
      path,
      serializeNote({ type: 'rule-change', status: 'quarantined', source: 'external-derived', trust: 0, derived_from: url, rule: stem(note.path), created: today, tags: ['company/rule-change'] }, body),
      `Rule source changed — ${stem(note.path)}`,
    );

    // The rule page itself is the founder's: flagged through the conditional
    // path, so an edit they made a minute ago wins over the flag.
    if (note.fm.status !== 'source-changed') {
      await writeVaultNote({ path: note.path, content: setFields(note.text, { status: 'source-changed', source_changed: today }), message: `Rule source changed — ${stem(note.path)}`, expectedSha: note.sha });
    }
    found.changed.push({ rule: stem(note.path), url, added: added.length, removed: removed.length, note: written ? path : null });
    await notify(`A rule page the company relies on changed: ${stem(note.path)}.\n${url}\n${added.length} lines added, ${removed.length} removed. Read the page, then set the rule's status back to reviewed. The detail is in the vault under Inbox/untrusted.`);
  }

  writeJson(FILE, state);
  return found;
}
