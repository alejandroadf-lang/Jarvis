// Defines an agent from structured fields instead of a hand-written prompt.
//
// The 27 roles that exist today each carry 30-40 lines of bespoke prose, and
// that is *why they are good* — the Validation Critic's instruction to treat
// "it's cheaper for us" as a non-answer is a specific judgment that no
// template would have produced. So this does not replace them. Generating
// 150 generic prompts would give this company a bigger roster and worse
// judgment, which is the opposite of the point.
//
// What it replaces is the cost of the *ordinary* ones. A role whose brief is
// genuinely "be the X specialist, care about these four things, push back
// when Y" doesn't need hand-carving, and making those cheap to add is what
// lets a roster grow without the prompt file becoming unmaintainable.
//
// The escape hatch matters as much as the template: pass `systemPrompt` and
// it wins outright. A data-defined role that turns out to need real judgment
// gets promoted to a hand-written one by adding one field, with nothing else
// to migrate.

/**
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.title
 * @param {string} spec.department
 * @param {string|null} spec.reportsTo
 * @param {string[]} [spec.reports]
 * @param {string} spec.mission - one line; also shown in the org chart UI
 * @param {string} spec.consultFor - when a manager should reach for this role
 * @param {string[]} [spec.cares] - what this role actually weighs, in priority order
 * @param {string} [spec.pushesBackOn] - what it should refuse or challenge
 * @param {string} [spec.systemPrompt] - a hand-written prompt; wins outright
 * @param {string} [spec.style] - shared house style appended to generated prompts
 */
export function defineAgent(spec) {
  const {
    id,
    title,
    department,
    reportsTo = null,
    reports = [],
    mission,
    consultFor,
    cares = [],
    pushesBackOn,
    systemPrompt,
    style = '',
    ...rest
  } = spec;

  return {
    id,
    title,
    department,
    reportsTo,
    reports,
    mission,
    toolDescription: `Consult the ${title} ${consultFor}.`,
    systemPrompt: systemPrompt || generatePrompt({ title, mission, cares, pushesBackOn, style }),
    ...rest,
  };
}

function generatePrompt({ title, mission, cares, pushesBackOn, style }) {
  const parts = [`You are the ${title}. ${mission}`];

  if (cares.length) {
    parts.push(
      '',
      'What you actually weigh, in this order:',
      cares.map((c, i) => `${i + 1}. ${c}`).join('\n')
    );
  }

  if (pushesBackOn) {
    parts.push('', `Push back when: ${pushesBackOn}`);
  }

  // Every generated role gets this, because the failure mode of a templated
  // prompt is an agent that produces confident, agreeable, unfalsifiable
  // paragraphs — which is worse than no agent at all, since it costs money
  // and a manager has to read it.
  parts.push(
    '',
    `Answer only within your remit. If the question is really someone else's,
say so and say whose rather than producing a plausible answer outside what
you actually know. "This isn't my call, and here's who should make it" is a
useful reply; a confident paragraph on a subject you have no basis for is
not.

If you don't have the information to answer well, say what you'd need. Never
pad a thin answer to look substantial — a short reply that is actually true
is worth more than a long one that isn't.`
  );

  if (style) parts.push('', style);
  return parts.join('\n');
}
