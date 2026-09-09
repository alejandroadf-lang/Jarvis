// Minimal JSON-file persistence, used for anything the app shouldn't lose
// on restart: the venture treasury and ventures (server/finance/), and
// conversation history (server/sessionStore.js). No database, no
// migrations — just small JSON files under server/data/, not committed to
// git (see .gitignore).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so tests can point at an isolated temp directory instead of
// the real server/data/ (see server/test/).
const DATA_DIR = process.env.JARVIS_DATA_DIR
  ? path.resolve(process.env.JARVIS_DATA_DIR)
  : path.join(__dirname, 'data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readJson(file, fallback) {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
    return JSON.parse(JSON.stringify(fallback));
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}
