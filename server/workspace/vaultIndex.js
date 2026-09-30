// Search over the vault, built on our server because nothing in Obsidian runs
// for the agents: its search, Bases, backlinks and graph all live in the app on
// the founder's phone, and the agents see the repo only through the GitHub API.
//
// What the research supports is simple: plain-text search with frontmatter
// filters and links computed from [[wikilinks]] is competitive with heavier
// retrieval at this size, and embeddings are worth their cost only once lexical
// search demonstrably misses (a thousand-plus notes, or a vocabulary
// mismatch). So this is substring scoring, filters and backlinks, and nothing
// else.
//
// The cost concern is GitHub calls, not model tokens: every note is a request.
// So content is cached by the blob sha the tree listing already carries; a
// search after the vault changed re-fetches only the notes that changed, and
// one after nothing changed costs a single (cached) listing.

import { readFileMeta, listFiles } from '../deploy/github.js';
import { isWorkspaceConfigured, workspaceConfig, QUARANTINE_FOLDER } from './vault.js';
import { parseNote, wikilinks } from './frontmatter.js';

const LISTING_TTL_MS = 60 * 1000;
const MAX_FILES = 600;
const MAX_CHARS = 20000;
const POOL = 6;
// Daily reports are a note a day for the life of the company; only the recent
// ones are worth an API call each.
const REPORT_DAYS = 45;

const HIDDEN = /^(\.obsidian|\.trash|\.git)(\/|$)/i;

let files = new Map(); // path -> { sha, text, fm, body }
let listing = { at: 0, entries: null };

export function invalidateIndex() {
  files = new Map();
  listing = { at: 0, entries: null };
}

function wanted(path, prefixes) {
  if (!/\.md$/i.test(path) || HIDDEN.test(path)) return false;
  if (prefixes && !prefixes.some((p) => path.startsWith(p))) return false;
  const report = path.match(/^Company\/Daily Reports\/(\d{4}-\d{2}-\d{2})\.md$/);
  if (report && Date.now() - Date.parse(report[1]) > REPORT_DAYS * 86_400_000) return false;
  return true;
}

async function entries() {
  if (listing.entries && Date.now() - listing.at < LISTING_TTL_MS) return listing.entries;
  const { owner, repo, branch } = workspaceConfig();
  const result = await listFiles({ owner, repo, branch, limit: 2000 });
  listing = { at: Date.now(), entries: result.files };
  return result.files;
}

/**
 * Every wanted note with its text and parsed frontmatter, re-fetching only what
 * changed since the last call. `prefixes` narrows to folders.
 */
export async function loadNotes({ prefixes } = {}) {
  if (!isWorkspaceConfigured()) return [];
  const { owner, repo, branch } = workspaceConfig();
  const listed = (await entries()).filter((e) => wanted(e.path, prefixes)).slice(0, MAX_FILES);

  const stale = listed.filter((e) => files.get(e.path)?.sha !== e.sha);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(POOL, stale.length) }, async () => {
      while (next < stale.length) {
        const e = stale[next++];
        try {
          const got = await readFileMeta({ owner, repo, branch, path: e.path });
          if (!got) continue;
          const { fm, body } = parseNote(got.text.slice(0, MAX_CHARS));
          files.set(e.path, { sha: e.sha, text: got.text.slice(0, MAX_CHARS), fm, body });
        } catch (err) {
          console.error(`Vault index: could not read ${e.path}:`, err.message);
        }
      }
    }),
  );
  return listed.filter((e) => files.has(e.path)).map((e) => ({ path: e.path, ...files.get(e.path) }));
}

const dateOf = (fm) => String(fm.updated || fm.date || fm.created || '').slice(0, 10);

function snippet(text, at, len = 220) {
  const start = Math.max(0, at - 60);
  return text.slice(start, start + len).replace(/\s+/g, ' ').trim();
}

/**
 * Notes matching a query, best first, optionally filtered by frontmatter. With
 * no query it is a filtered listing ("what changed since Monday").
 * Quarantined notes are excluded unless asked for: they are text nobody has
 * vouched for.
 */
export async function searchNotes({ query = '', venture, type, status, since, folder, limit = 8, includeUntrusted = false } = {}) {
  const notes = await loadNotes({});
  const tokens = String(query).toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length > 1);
  const prefix = folder ? `${String(folder).replace(/^\/+|\/+$/g, '')}/` : null;

  const scored = [];
  for (const n of notes) {
    if (!includeUntrusted && n.path.startsWith(`${QUARANTINE_FOLDER}/`)) continue;
    if (prefix && !n.path.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    if (venture && String(n.fm.venture || '').toLowerCase() !== String(venture).toLowerCase()) continue;
    if (type && n.fm.type !== type) continue;
    if (status && n.fm.status !== status) continue;
    if (since && dateOf(n.fm) < since) continue;

    let score = 0;
    let first = -1;
    if (tokens.length) {
      const title = n.path.toLowerCase();
      const body = n.text.toLowerCase();
      for (const t of tokens) {
        if (title.includes(t)) score += 3;
        const at = body.indexOf(t);
        if (at !== -1) {
          score += 1 + Math.min(4, body.split(t).length - 2);
          if (first === -1) first = at;
        }
      }
      if (!score) continue;
    }
    scored.push({ n, score, first });
  }
  scored.sort((a, b) => b.score - a.score || dateOf(b.n.fm).localeCompare(dateOf(a.n.fm)));
  return scored.slice(0, limit).map(({ n, score, first }) => ({
    path: n.path,
    score,
    type: n.fm.type || null,
    status: n.fm.status || null,
    venture: n.fm.venture || null,
    date: dateOf(n.fm) || null,
    snippet: first >= 0 ? snippet(n.text, first) : snippet(n.body, 0),
  }));
}

/** Notes that link to a note by name: what a graph view would show the founder. */
export async function backlinksTo(title) {
  const target = String(title).toLowerCase();
  const notes = await loadNotes({});
  return notes
    .filter((n) => wikilinks(n.text).some((l) => l.toLowerCase() === target))
    .map((n) => n.path);
}
