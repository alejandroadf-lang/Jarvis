// The container's entry point: drop root, then start the server.
//
// A separate file because the drop has to happen before index.js is loaded.
// Loading it reads and writes the data directory at module level (sessions
// are seeded from disk on import), and a file created as root there would be
// one the server can no longer write once it has dropped. `npm start` and
// local development still run index.js directly; there is no root to drop.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropRoot } from './privileges.js';
import { circadianDataDir } from './circadian.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const jarvisData = (process.env.JARVIS_DATA_DIR || '').trim()
  ? path.resolve(process.env.JARVIS_DATA_DIR)
  : path.join(here, 'data');

const outcome = dropRoot({ dirs: [...new Set([jarvisData, path.resolve(circadianDataDir())])] });
console.log(`Privileges: ${outcome.reason}.`);

await import('./index.js');
