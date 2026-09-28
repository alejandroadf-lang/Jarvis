// Minimal JSON-file persistence, used for anything the app shouldn't lose
// on restart: the venture treasury and ventures (server/finance/), and
// conversation history (server/sessionStore.js). No database, no
// migrations — just small JSON files under server/data/, not committed to
// git (see .gitignore).
//
// Two properties every caller leans on without saying so:
//
// - A write is all or nothing. The file is written beside its target and
//   renamed over it, which the filesystem does atomically. Writing the target
//   in place, as this used to, meant a crash, a full volume or a killed
//   container mid-write left half a JSON document; the next read then threw a
//   SyntaxError out of every request that touched that file, which for
//   ventures.json is most of them. Circadian's store.py has done it this way
//   from the start; this brings the Node side level with it.
// - A file that cannot be parsed says which file. The bare "Unexpected token"
//   from JSON.parse names nothing, and the fix (restore the file from the
//   volume's backup, or move it aside) starts with knowing which one it was.
//   The file is left in place: a store that replaced unreadable data with the
//   fallback would turn a recoverable outage into a silent loss.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Overridable: tests point this at an isolated temp directory (see
// server/test/), and in production it should point at a mounted
// persistent volume (e.g. JARVIS_DATA_DIR=/data on Railway — see
// README.md's "Deploy to Railway" section) so state survives a redeploy
// instead of living in the container's ephemeral filesystem.
//
// Resolved per call rather than once at import: a test that sets the env
// var in a before() hook would otherwise still be writing wherever this
// module happened to resolve when it was first loaded, which is how real
// data files end up with test junk in them.
function dataDir() {
  return process.env.JARVIS_DATA_DIR ? path.resolve(process.env.JARVIS_DATA_DIR) : path.join(__dirname, 'data');
}

function ensureDataDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback) {
  const dir = dataDir();
  ensureDataDir(dir);
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) {
    writeAtomically(filePath, fallback);
    return JSON.parse(JSON.stringify(fallback));
  }
  const text = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(text);
  } catch (err) {
    const error = new Error(`${filePath} is not valid JSON (${err.message}). It was left as it is: restore it from a backup or move it aside.`);
    error.code = 'STORE_CORRUPT';
    error.file = filePath;
    throw error;
  }
}

export function writeJson(file, data) {
  const dir = dataDir();
  ensureDataDir(dir);
  writeAtomically(path.join(dir, file), data);
}

/** Whether a store file exists, without creating it the way readJson does. */
export function existsJson(file) {
  return fs.existsSync(path.join(dataDir(), file));
}

/**
 * Read, change, write, in one call. Every store module used to spell this
 * out as load() / mutate / save(); one name for it keeps a new store from
 * forgetting the save, and puts the one place to add locking if this app ever
 * runs more than one process against the same volume.
 */
export function updateJson(file, fallback, change) {
  const data = readJson(file, fallback);
  const next = change(data);
  writeJson(file, next === undefined ? data : next);
  return next === undefined ? data : next;
}

// A temporary file in the same directory, so the rename stays on one
// filesystem (rename across filesystems is a copy, and not atomic). The pid
// and a counter keep two writers in one directory from sharing a name.
let serial = 0;
function writeAtomically(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${++serial}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}
