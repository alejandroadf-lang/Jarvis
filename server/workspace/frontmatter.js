// Flat YAML frontmatter, read and written as text.
//
// Obsidian's Properties, Bases and Dataview all want flat typed frontmatter,
// and the agents read the same files as plain text, so the format here is the
// small flat subset: `key: value` and `key: [a, b]`. Deliberately not a YAML
// parser: a dependency that can throw on a note a person edited on a phone
// would take the lint, the index and the compile down with it, and nested
// YAML is one thing Obsidian's own Properties UI does not support.

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

/** { fm, body } for a note; fm is {} when there is no frontmatter. */
export function parseNote(text) {
  const raw = String(text || '');
  const m = raw.match(BLOCK);
  if (!m) return { fm: {}, body: raw };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim();
    fm[kv[1]] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map((x) => unquote(x)).filter(Boolean)
      : unquote(value);
  }
  return { fm, body: raw.slice(m[0].length) };
}

// Quoted when YAML would misread it: a colon-space, a leading indicator, a
// hash, or edge whitespace. An unquoted `evidence: PR #12: fixed it` is a
// parse error in Obsidian's Properties panel.
export function yamlValue(v) {
  if (Array.isArray(v)) return `[${v.map((x) => yamlValue(x)).join(', ')}]`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v ?? '').replace(/\s*\n\s*/g, ' ');
  return /(:\s|^[\s\-?&*!|>'"%@`{}\[\],]|\s#|^\s|\s$)/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export function serializeNote(fm, body) {
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${lines.join('\n')}\n---\n${String(body || '').replace(/^\n+/, '\n')}`;
}

/** The note with these frontmatter fields set (added or replaced), body untouched. */
export function setFields(text, fields) {
  const { fm, body } = parseNote(text);
  return serializeNote({ ...fm, ...fields }, body);
}

/**
 * Adds text under a `## heading`, creating the section at the end when it is
 * not there. Only ever adds, so an edit cannot remove what a person wrote.
 */
export function appendToSection(body, heading, text) {
  const title = String(heading).replace(/^#+\s*/, '').trim();
  const lines = String(body || '').replace(/\s+$/, '').split('\n');
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').test(l));
  const block = String(text).trim();
  if (at === -1) return `${lines.join('\n')}\n\n## ${title}\n\n${block}\n`;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  const before = lines.slice(0, end).join('\n').replace(/\s+$/, '');
  const after = lines.slice(end).join('\n');
  return `${before}\n\n${block}\n${after ? `\n${after}` : ''}\n`;
}

/** [[Wikilink]] targets in a note, without aliases or headings. */
export function wikilinks(text) {
  return [...String(text || '').matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim());
}
