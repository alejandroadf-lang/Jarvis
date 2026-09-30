// What the team learned, and whether to believe it.
//
// Reflection helps an agent when it is tied to an outside signal (a test that
// passed, a customer who replied) and does not reliably help when the model
// only judges itself; retrieved notes that are wrong or stale get copied, and
// a model rewriting a page erodes detail. So a lesson here is a claim with a
// status, not a fact:
//
//   quarantined  written from text that came from outside (a web page, an
//                email). Never read into shared context, never compiled,
//                until the founder changes the status by hand.
//   candidate    written by a lead, with evidence, unconfirmed. Shown in the
//                context marked as unconfirmed; not compiled into knowledge.
//   trusted      confirmed by a second, independent lesson, or by the founder
//                editing `status:` in Obsidian. The only kind the weekly
//                knowledge compile reads.
//   disputed     a newer lesson contradicts it. Excluded until resolved.
//   expired      past its `expires` date. Excluded; the founder can extend it.
//
// The status lives in the note's frontmatter, so the founder's edit on their
// phone is the truth; the local index is a cache of it, refreshed by
// syncLessons(). The server stamps who wrote it and the trust level; the model
// never states either about itself.

import { readJson, writeJson } from '../store.js';
import { listVentures } from '../finance/ventures.js';
import { readFileMeta } from '../deploy/github.js';
import { parseNote, setFields } from './frontmatter.js';
import { checkVaultText } from './writeGate.js';
import { loadNotes } from './vaultIndex.js';
import {
  isWorkspaceConfigured,
  workspaceConfig,
  noteName,
  formatLesson,
  writeVaultNote,
  stampFields,
  LESSONS_FOLDER,
  QUARANTINE_FOLDER,
} from './vault.js';

const FILE = 'lessons.json';
const MAX_KEPT = 300;
const LESSON_CHARS = 3000;
const CONTEXT_LESSONS = 8;
const CONTEXT_CHARS = 1300;

// Evidence has to point at something a person could open: a pull request, a
// dated source, a link, a note, a record id. The server cannot look each of
// those up, but it can refuse "it seemed to work", which is what a
// self-confirming lesson looks like.
const CHECKABLE = /(#\d+|\bPR\s*\d+|https?:\/\/\S+|\d{4}-\d{2}-\d{2}|\S+\.md\b|\b[vt]_[0-9a-z_]{6,})/i;

const today = () => new Date().toISOString().slice(0, 10);

function load() {
  return readJson(FILE, { items: [] });
}

function perDayLimit() {
  const n = Number.parseInt(process.env.VAULT_LESSONS_PER_DAY, 10);
  return Number.isFinite(n) && n >= 0 ? n : 6;
}

function ttlDays() {
  const n = Number.parseInt(process.env.VAULT_LESSON_TTL_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 75;
}

const addDays = (day, n) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);

function lessonPath(folder, title) {
  return `${folder}/${today()} ${noteName(title)}.md`;
}

export async function writeLesson({ title, lesson, evidence, ventureId, confirms, contradicts, fromExternal }, { agentId }) {
  const cleanTitle = String(title || '').trim();
  const text = String(lesson || '').trim();
  const proof = String(evidence || '').trim();
  if (!cleanTitle || !text) return 'Not saved: a lesson needs both a title and the lesson itself.';
  if (!proof || !CHECKABLE.test(proof)) {
    return 'Not saved: a lesson needs evidence someone can open: a pull request (#12), a dated source (2026-09-30 customer reply), a link, or a note path. "It seemed to work" is not evidence. Add it as `evidence`.';
  }
  const refused = checkVaultText(cleanTitle, text, proof);
  if (refused) return refused;

  const data = load();
  const made = data.items.filter((i) => i.created === today()).length;
  if (made >= perDayLimit()) {
    return `Not saved: ${made} lessons have been kept today, the limit (VAULT_LESSONS_PER_DAY). Fold this into one of them or keep it for tomorrow.`;
  }

  const venture = ventureId ? listVentures().find((v) => v.id === ventureId) : null;
  if (ventureId && !venture) return `Not saved: no venture with id "${ventureId}". Leave ventureId out, or use an id from the venture list.`;

  const { owner, repo, branch } = workspaceConfig();
  const inLessons = (p) => typeof p === 'string' && p.startsWith(`${LESSONS_FOLDER}/`) && /\.md$/i.test(p) && !p.includes('..');
  const earlier = {};
  for (const [key, path] of [['confirms', confirms], ['contradicts', contradicts]]) {
    if (!path) continue;
    if (!inLessons(path)) return `Not saved: ${key} must be the path of an existing lesson under ${LESSONS_FOLDER}/.`;
    const got = await readFileMeta({ owner, repo, branch, path });
    if (!got) return `Not saved: no lesson at "${path}" to ${key === 'confirms' ? 'confirm' : 'contradict'}. list_vault_notes shows what exists.`;
    earlier[key] = { path, ...got, fm: parseNote(got.text).fm };
  }
  if (earlier.confirms) {
    const fm = earlier.confirms.fm;
    const sameSource = fm.agent === agentId && fm.created === today();
    if (sameSource || String(fm.evidence || '').trim() === proof) {
      return 'Not saved: a confirmation must be independent: from a different agent or a different day, and on different evidence than the lesson it confirms.';
    }
  }

  const quarantined = Boolean(fromExternal);
  const trusted = Boolean(earlier.confirms) && !quarantined;
  const status = quarantined ? 'quarantined' : trusted ? 'trusted' : 'candidate';
  const path = lessonPath(quarantined ? QUARANTINE_FOLDER : LESSONS_FOLDER, cleanTitle);
  if (await readFileMeta({ owner, repo, branch, path })) {
    return `Not saved: a lesson called "${noteName(cleanTitle)}" already exists today. Give this one a more specific title; existing notes are never overwritten.`;
  }

  // The notes this one confirms or contradicts are changed first: if that fails
  // nothing is written, so a lesson is never trusted on the strength of a
  // confirmation that did not land.
  for (const [key, newStatus, field] of [['confirms', 'trusted', 'confirmed_by'], ['contradicts', 'disputed', 'disputed_by']]) {
    const e = earlier[key];
    if (!e) continue;
    const res = await writeVaultNote({
      path: e.path,
      content: setFields(e.text, { status: newStatus, [field]: path }),
      message: `Lesson ${newStatus} — ${noteName(e.path)}`,
      expectedSha: e.sha,
    });
    if (!res.ok) return `Not saved: could not update "${e.path}" (${res.reason}). Nothing was written.`;
  }

  const created = today();
  const body = text.slice(0, LESSON_CHARS);
  const written = await writeVaultNote({
    path,
    content: formatLesson({
      title: cleanTitle,
      lesson: body,
      ventureTitle: venture?.title,
      fields: {
        date: created,
        created,
        status,
        ...stampFields({ agentId, trust: quarantined ? 0 : trusted ? 2 : 1, source: quarantined ? 'external-derived' : 'agent' }),
        evidence: proof,
        expires: addDays(created, ttlDays()),
        confirms: earlier.confirms ? [earlier.confirms.path] : undefined,
        contradicts: earlier.contradicts ? [earlier.contradicts.path] : undefined,
      },
    }),
    message: `Lesson — ${noteName(cleanTitle)}`,
    expectedSha: null,
  });
  if (!written.ok) return `Not saved: the vault write did not go through (${written.reason}). Nothing was recorded.`;

  // The local index is written only after the commit, so the shared context
  // never lists a lesson that is not in the vault.
  const next = load();
  next.items.push({
    at: new Date().toISOString(),
    created,
    agentId,
    title: noteName(cleanTitle),
    path,
    ventureId: venture?.id || null,
    status,
    expires: addDays(created, ttlDays()),
    evidence: proof.slice(0, 200),
    summary: body.replace(/\s+/g, ' ').slice(0, 220),
    reads: 0,
    lastUsed: null,
  });
  if (earlier.confirms) for (const i of next.items) if (i.path === earlier.confirms.path) i.status = 'trusted';
  if (earlier.contradicts) for (const i of next.items) if (i.path === earlier.contradicts.path) i.status = 'disputed';
  next.items = next.items.slice(-MAX_KEPT);
  writeJson(FILE, next);

  const where = quarantined ? `${QUARANTINE_FOLDER}/, where nothing reads it until you set its status` : `${LESSONS_FOLDER}/ as ${status}`;
  return `Saved as "${path}" (${where}).${status === 'candidate' ? ' It becomes trusted when a second, independent lesson confirms it (confirms: this path) or the founder approves it.' : ''}`;
}

/**
 * Refreshes the local index from the notes themselves, so a status the founder
 * changed in Obsidian, and an expiry date passing, take effect. Fail-quiet.
 */
export async function syncLessons() {
  if (!isWorkspaceConfigured()) return 0;
  let notes;
  try {
    notes = await loadNotes({ prefixes: [`${LESSONS_FOLDER}/`, `${QUARANTINE_FOLDER}/`] });
  } catch (err) {
    console.error('Lesson sync failed:', err.message);
    return 0;
  }
  const data = load();
  const byPath = new Map(data.items.map((i) => [i.path, i]));
  let changed = 0;
  for (const n of notes) {
    if (n.fm.type !== 'lesson') continue;
    let item = byPath.get(n.path);
    if (!item) {
      // Written by hand or before this index existed: adopt it as it stands.
      item = { at: new Date().toISOString(), created: n.fm.created || n.fm.date || today(), agentId: n.fm.agent || 'founder', title: n.path.split('/').pop().replace(/\.md$/, ''), path: n.path, ventureId: null, evidence: String(n.fm.evidence || ''), summary: n.body.replace(/^#.*$/m, '').replace(/\s+/g, ' ').trim().slice(0, 220), reads: 0, lastUsed: null };
      data.items.push(item);
    }
    let status = n.fm.status || 'candidate';
    const expires = n.fm.expires || item.expires || null;
    // Expiry is computed, not written: nothing has to edit a note for it to lapse.
    if (expires && expires < today() && !['disputed', 'quarantined'].includes(status)) status = 'expired';
    if (item.status !== status || item.expires !== expires) changed += 1;
    item.status = status;
    item.expires = expires;
  }
  writeJson(FILE, data);
  return changed;
}

export function allLessons() {
  return load().items;
}

export function recentLessons({ days = 14, ventureId, status } = {}) {
  const since = Date.now() - days * 86_400_000;
  const wanted = status ? (Array.isArray(status) ? status : [status]) : null;
  return load().items.filter(
    (i) => Date.parse(i.at) >= since && (!ventureId || !i.ventureId || i.ventureId === ventureId) && (!wanted || wanted.includes(i.status)),
  );
}

/** Lessons the compile may build on: trusted, in date, for this venture or general. */
export function trustedLessons({ ventureId, days = 120 } = {}) {
  return recentLessons({ days, ventureId, status: 'trusted' });
}

/** A lesson was read: the reuse count that tells whether the notebook is used at all. */
export function markLessonUsed(path) {
  const data = load();
  const item = data.items.find((i) => i.path === path);
  if (!item) return;
  item.reads = (item.reads || 0) + 1;
  item.lastUsed = new Date().toISOString();
  writeJson(FILE, data);
}

export function lessonMetrics() {
  const items = load().items;
  const count = (s) => items.filter((i) => i.status === s).length;
  return {
    total: items.length,
    candidate: count('candidate'),
    trusted: count('trusted'),
    disputed: count('disputed'),
    expired: count('expired'),
    quarantined: count('quarantined'),
    everRead: items.filter((i) => (i.reads || 0) > 0).length,
    totalReads: items.reduce((n, i) => n + (i.reads || 0), 0),
    neverRead: items.filter((i) => !(i.reads || 0) && i.status !== 'quarantined').length,
  };
}

/**
 * An index of what the team has learned lately, for the shared context; the
 * bodies are one read_vault_note away. Quarantined, disputed and expired
 * lessons never appear, and unconfirmed ones are marked as such so an agent
 * does not lean on a claim nobody has checked.
 */
export function buildLessonsContext() {
  if (!isWorkspaceConfigured()) return '';
  const items = load().items.filter((i) => ['trusted', 'candidate'].includes(i.status)).slice(-CONTEXT_LESSONS).reverse();
  const head =
    "The vault is the team's notebook. Team leads can search_vault_notes, list_vault_notes, read_vault_note and write_lesson (with evidence). " +
    'Library/ holds material the founder wants you to learn from; check it when a decision could use it.';
  if (!items.length) return head;
  const lines = items.map((i) => `- ${i.created || i.at.slice(0, 10)} ${i.title} (${i.agentId}, ${i.status === 'trusted' ? 'confirmed' : 'UNCONFIRMED, do not lean on it'}): ${i.summary}`);
  return `${head}\nLessons the team has kept lately (full notes in ${LESSONS_FOLDER}/):\n${lines.join('\n')}`.slice(0, CONTEXT_CHARS);
}
