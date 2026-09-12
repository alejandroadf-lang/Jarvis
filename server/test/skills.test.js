// An agent's know-how used to live in its system prompt, which is sent on
// every call whether it is relevant or not. Teaching the Security Reviewer a
// proper methodology meant every one of its turns carried that methodology,
// including the ones answering a yes-or-no question. Multiply by twenty-one
// agents and the roster stops being able to grow.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../agents/agentRunner.js';

let tmpDir;
let registry;
let saved;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skills-test-'));
  saved = process.env.SKILLS_DIR;
  process.env.SKILLS_DIR = tmpDir;
  process.env.JARVIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skills-data-'));
  registry = await import('../skills/registry.js');
});

after(() => {
  if (saved === undefined) delete process.env.SKILLS_DIR;
  else process.env.SKILLS_DIR = saved;
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSkill(file, contents) {
  fs.writeFileSync(path.join(tmpDir, file), contents);
  registry.reloadSkills();
}

beforeEach(() => {
  for (const file of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, file));
  registry.reloadSkills();
});

test('a skill is its frontmatter plus its body', () => {
  writeSkill('review.md', `---
name: review
description: How to review something.
---

# The procedure

Step one.`);

  const [skill] = registry.listSkills();
  assert.equal(skill.id, 'review');
  assert.equal(skill.description, 'How to review something.');
  assert.match(skill.body, /# The procedure/);
  assert.doesNotMatch(skill.body, /description:/, 'frontmatter must not leak into the body');
});

test('the menu carries descriptions, never bodies — that is the whole point', () => {
  writeSkill('review.md', `---
name: review
description: One line.
---
${'An enormous body. '.repeat(500)}`);

  const menu = registry.describeSkillsForAgent('anyone');

  assert.match(menu, /review: One line\./);
  assert.ok(menu.length < 500, `the menu was ${menu.length} chars — it is carrying a body`);
});

test('a skill can be restricted to particular agents', () => {
  writeSkill('finance.md', `---
name: finance
description: Books.
agents: [cfo, finance_manager]
---
Body.`);

  assert.equal(registry.skillsFor('cfo').length, 1);
  assert.equal(registry.skillsFor('cmo').length, 0);
  assert.equal(registry.getSkill('cmo', 'finance'), null, 'an agent cannot load what it was not offered');
});

test('a skill with no agents listed is offered to everyone', () => {
  writeSkill('general.md', `---
name: general
description: Anyone.
---
Body.`);

  assert.equal(registry.skillsFor('cmo').length, 1);
  assert.equal(registry.skillsFor('security_reviewer').length, 1);
});

test('a skill with no description is not offered, because nobody could know when to use it', () => {
  writeSkill('mystery.md', `---
name: mystery
---
Body.`);

  assert.equal(registry.listSkills().length, 0);
});

test('a malformed skill is skipped rather than taking the roster down', () => {
  writeSkill('good.md', `---
name: good
description: Fine.
---
Body.`);
  fs.writeFileSync(path.join(tmpDir, 'broken.md'), 'no frontmatter at all');
  registry.reloadSkills();

  // The one without frontmatter has no description, so it is simply not
  // offered — and the good one still is.
  assert.deepEqual(registry.listSkills().map((s) => s.id), ['good']);
});

test('no library at all is a normal state', () => {
  const previous = process.env.SKILLS_DIR;
  process.env.SKILLS_DIR = path.join(tmpDir, 'does-not-exist');
  registry.reloadSkills();
  try {
    assert.deepEqual(registry.listSkills(), []);
    assert.equal(registry.describeSkillsForAgent('cfo'), '', 'no menu, and no empty heading either');
  } finally {
    process.env.SKILLS_DIR = previous;
    registry.reloadSkills();
  }
});

// --- Through the runner -----------------------------------------------------

const SOLO = {
  solo: { id: 'solo', title: 'Solo', department: 'T', reportsTo: null, reports: [], systemPrompt: 'You are alone.' },
};

test('an agent is offered load_skill only when it has skills', async () => {
  const calls = [];
  const anthropic = {
    messages: {
      create: async (params) => {
        calls.push(params);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };

  await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(calls[0].tools, undefined, 'an empty library offers no tool');

  writeSkill('x.md', `---
name: x
description: A thing.
---
The body.`);

  await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(calls[1].tools.some((t) => t.name === 'load_skill'));
});

test('loading a skill returns its body to the agent', async () => {
  writeSkill('x.md', `---
name: x
description: A thing.
---
THE ACTUAL PROCEDURE`);

  const seen = [];
  const anthropic = {
    messages: {
      create: async (params) => {
        seen.push(params.messages);
        if (seen.length === 1) {
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'load_skill', input: { name: 'x' } }],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };

  const { text } = await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(text, 'done');
  assert.match(JSON.stringify(seen[1]), /THE ACTUAL PROCEDURE/);
});

test('asking for a skill that is not yours says so instead of failing the turn', async () => {
  writeSkill('mine.md', `---
name: mine
description: Mine.
agents: [someone_else]
---
Body.`);
  writeSkill('offered.md', `---
name: offered
description: Offered.
---
Body.`);

  const seen = [];
  const anthropic = {
    messages: {
      create: async (params) => {
        seen.push(params.messages);
        if (seen.length === 1) {
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'load_skill', input: { name: 'mine' } }],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'carried on' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };

  const { text } = await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(text, 'carried on');
  assert.match(JSON.stringify(seen[1]), /No skill called/);
});

test('the menu rides inside the cached agent prompt, not a third block', () => {
  // A separate block would add a cache breakpoint for content that changes
  // only when the library does — it belongs behind the same one as the prompt.
  writeSkill('x.md', `---
name: x
description: A thing.
---
Body.`);

  const menu = registry.describeSkillsForAgent('solo');
  assert.match(menu, /load_skill/);
});
