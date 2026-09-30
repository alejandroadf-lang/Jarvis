// A skill the team drafted, that the founder approved by editing one word.
//
// The evidence is one-sided: skills a person curated helped agents, and skills
// an agent wrote for itself scored below having none. So an agent may draft a
// skill (propose_skill, from a trusted lesson) but the draft does nothing. It
// waits in Inbox/Skill Proposals with `status: pending`; the founder reads the
// procedure (a skill is instructions every agent will follow) and changes the
// status to `approved`. Only then does this copy it, from the vault into the
// data volume, where the skills registry reads it. Rejecting, or changing the
// status back, removes it at the next sync.
//
// Not built, deliberately: an automatic check that an approved skill does not
// make things worse (a replay of past sessions with and without it). It needs
// enough real sessions to be worth measuring; until then the founder's
// reading is the check.

import fs from 'node:fs';
import path from 'node:path';
import { loadNotes } from './vaultIndex.js';
import { isWorkspaceConfigured, SKILL_PROPOSALS_FOLDER } from './vault.js';
import { checkVaultText } from './writeGate.js';
import { approvedSkillsDir, reloadSkills, listSkills } from '../skills/registry.js';

const NAME = /^[a-z0-9]+(-[a-z0-9]+){0,6}$/;

function procedureOf(body) {
  const m = body.match(/## Procedure\s*\n([\s\S]*?)(\n---\n|$)/);
  return m ? m[1].trim() : '';
}

/** Copies approved proposals into the data volume and removes ones no longer approved. Returns the names now active. */
export async function syncApprovedSkills() {
  if (!isWorkspaceConfigured()) return [];
  const notes = await loadNotes({ prefixes: [`${SKILL_PROPOSALS_FOLDER}/`] });
  const dir = approvedSkillsDir();
  fs.mkdirSync(dir, { recursive: true });

  // The library's own skills are read first and win a name clash; do not write
  // a file that would only be ignored.
  const builtIn = new Set(listSkills().filter((s) => !fs.existsSync(path.join(dir, `${s.id}.md`))).map((s) => s.id));

  const active = new Set();
  for (const n of notes) {
    if (n.fm.type !== 'skill-proposal' || String(n.fm.status).toLowerCase() !== 'approved') continue;
    const name = String(n.fm.skill_name || '');
    const description = String(n.fm.skill_description || '').trim();
    const body = procedureOf(n.body);
    // Checked again on the way out: what was fine when proposed is what the
    // founder approved, but a note can be edited between.
    if (!NAME.test(name) || !description || body.length < 80 || builtIn.has(name) || checkVaultText(name, description, body)) {
      console.error(`Skill proposal ${n.path} was approved but not activated (name, description or procedure not acceptable).`);
      continue;
    }
    fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n${body}\n`);
    active.add(name);
  }
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.md') && !active.has(file.replace(/\.md$/, ''))) fs.rmSync(path.join(dir, file), { force: true });
  }
  reloadSkills();
  return [...active];
}
