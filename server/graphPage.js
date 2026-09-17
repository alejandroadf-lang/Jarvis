// Serves the company graph page.
//
// Kept as a real .html file read from disk rather than a template literal in
// JS, for two reasons. A page with this much CSS and script inside a template
// literal turns every backtick and every `${` into an escaping hazard — this
// codebase has already lost a turn to exactly one such escaped backtick. And a
// plain .html file can be opened directly in a browser while working on it.
//
// Read once and cached: it never changes between deploys, and re-reading it on
// every request would be a filesystem hit on a page the founder opens from a
// phone on a slow connection.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.join(__dirname, 'graphPage.html');

let cached = null;

export function graphPageHtml() {
  if (cached === null) cached = fs.readFileSync(PAGE_PATH, 'utf8');
  return cached;
}
