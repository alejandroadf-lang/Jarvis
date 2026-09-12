// Skills: procedures an agent loads only when the work calls for them.
//
// The pattern comes out of the Claude Code ecosystem, and the reason to want
// it here is arithmetic. An agent's know-how currently lives in its system
// prompt, which is sent on every call whether it is relevant or not. Teaching
// the Security Reviewer a proper OWASP methodology means every one of its
// turns carries that methodology, including the ones where someone asked it a
// yes-or-no question. Multiply by twenty-one agents and the roster stops being
// able to grow.
//
// A skill is a markdown file with frontmatter. The agent sees a one-line
// description of each skill available to it and calls `load_skill` when it
// wants the body. Shallow by design: one level, no nesting, no execution —
// this is knowledge, not code, and a skill that could run things would be a
// second action surface outside the scopes that govern the first.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Overridable so a venture can carry its own, and so tests don't read the
// real library.
function skillsDir() {
  const configured = (process.env.SKILLS_DIR || '').trim();
  return configured ? path.resolve(configured) : path.join(__dirname, 'library');
}

/**
 * Parses YAML-ish frontmatter. Deliberately not a YAML parser: the fields are
 * three strings and a list, and a dependency that can throw on a malformed
 * skill file would take the whole roster down at import time.
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    meta[key] = value.trim().replace(/^["']|["']$/g, '');
  }
  if (meta.agents) {
    meta.agents = meta.agents
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return { meta, body: match[2].trim() };
}

let cache = null;

/** Every skill on disk. Read once; call reloadSkills() after editing them. */
export function listSkills() {
  if (cache) return cache;

  const dir = skillsDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    // No library is a normal state — the company works without any skills.
    cache = [];
    return cache;
  }

  cache = files
    .map((file) => {
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf-8'));
        return {
          id: meta.name || file.replace(/\.md$/, ''),
          description: meta.description || '',
          // Omitted means every agent; a list restricts it. Restricting is
          // about keeping each agent's menu short, not about secrecy.
          agents: Array.isArray(meta.agents) ? meta.agents : null,
          body,
        };
      } catch (err) {
        console.error(`Skipping unreadable skill ${file}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean)
    .filter((skill) => {
      if (!skill.description) {
        // Without a description the agent has no way to know when to reach
        // for it, so it would only ever be dead weight in the menu.
        console.warn(`Skill "${skill.id}" has no description and will not be offered.`);
        return false;
      }
      return true;
    });

  return cache;
}

export function reloadSkills() {
  cache = null;
  return listSkills();
}

export function skillsFor(agentId) {
  return listSkills().filter((skill) => !skill.agents || skill.agents.includes(agentId));
}

export function getSkill(agentId, skillId) {
  return skillsFor(agentId).find((skill) => skill.id === skillId) || null;
}

/**
 * The menu an agent sees: names and one-liners only.
 *
 * This is the whole point — the descriptions cost a few dozen tokens, the
 * bodies cost thousands, and only the relevant body is ever paid for.
 */
export function describeSkillsForAgent(agentId) {
  const available = skillsFor(agentId);
  if (!available.length) return '';

  const lines = available.map((skill) => `- ${skill.id}: ${skill.description}`);
  return (
    'Skills you can load, by name, with the load_skill tool. Each is a ' +
    'procedure worth following when it applies — load one before doing that ' +
    'kind of work rather than after:\n' +
    lines.join('\n')
  );
}
