// Minimal JSON-file persistence, used for anything the app shouldn't lose
// on restart: the venture treasury and ventures (server/finance/), and
// conversation history (server/sessionStore.js). No database, no
// migrations — just small JSON files under server/data/, not committed to
// git (see .gitignore).

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
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
    return JSON.parse(JSON.stringify(fallback));
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function writeJson(file, data) {
  const dir = dataDir();
  ensureDataDir(dir);
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2));
}
