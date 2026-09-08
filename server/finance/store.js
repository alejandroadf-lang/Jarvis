// Minimal JSON-file persistence for the venture studio's state (ledger,
// ventures). The rest of the app keeps everything in memory — this is the
// one part where losing state on restart (a company's cash balance) would
// actually be annoying, so it's persisted to disk instead. No database, no
// migrations: just a couple of small JSON files under server/data/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

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
