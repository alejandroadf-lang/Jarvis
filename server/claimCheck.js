// Did the team do what it says it did?
//
// An agent reported "deploying auth.py" with no tool call behind it. That was
// caught by a person reading carefully, which is not a control — it is luck
// with a good habit attached. The `reporting-status` skill already asks agents
// not to do this, and an instruction in a prompt is a request; this file is
// the rule.
//
// It is possible at all because the runner now records every action-tool call
// in the trace (see agentRunner.js). A claim of work is checkable against the
// list of work actually attempted, in the same turn, for free.
//
// Deliberately narrow. It flags one shape: the reply asserts a real-world act
// was completed, and the trace contains no successful action of that kind. It
// does not judge whether the act was correct, or whether the summary is
// otherwise fair — only whether the thing it claims happened, happened.

// A family of claims, the tools that would satisfy it, and how the claim is
// phrased when it is true. Kept as whole phrases rather than single verbs
// because "commit" appears in "I could not commit" and in "I will commit
// tomorrow", neither of which is a claim that a commit occurred.
const CLAIMS = [
  {
    kind: 'a commit',
    tools: ['deploy_code', 'deploy_changes', 'revert_commit', 'open_pull_request'],
    patterns: [
      /\b(?:i|we)(?:'ve| have)? (?:just )?(?:deployed|committed|pushed|shipped|landed)\b/i,
      /\b(?:deployed|committed|pushed|landed) (?:the |a |it )?(?:\w+\s+)?(?:to|into) (?:the )?(?:repo|main|branch)\b/i,
      /\bthe (?:commit|change|fix|file) (?:is|has been) (?:now )?(?:live|landed|committed|deployed|pushed)\b/i,
      /\bhas been (?:deployed|committed|pushed|merged)\b/i,
    ],
  },
  {
    kind: 'an email to a real person',
    tools: ['send_customer_email'],
    patterns: [
      /\b(?:i|we)(?:'ve| have)? (?:just )?(?:sent|emailed|written to|reached out to)\b/i,
      /\bthe (?:email|message|note) (?:is|has been|was) sent\b/i,
    ],
  },
  {
    kind: 'a payment link',
    tools: ['create_payment_link'],
    patterns: [/\b(?:i|we)(?:'ve| have)? (?:just )?(?:created|generated|made) (?:a |the )?(?:payment|checkout) link\b/i],
  },
  {
    kind: 'a check run',
    tools: ['run_checks'],
    patterns: [
      /\b(?:i|we)(?:'ve| have)? (?:just )?ran the (?:checks|tests|suite)\b/i,
      /\bthe (?:checks|tests) (?:are|came back|passed|ran)\b/i,
    ],
  },
];

// Phrases that turn a claim into its opposite, or into a plan. Checked against
// the sentence the claim was found in, not the whole reply — an agent that
// deployed one thing and could not deploy another is reporting honestly.
const NEGATED = [
  /\b(?:could|can|did|do|would|will) ?n[o']?t\b/i,
  /\bunable to\b/i,
  /\bfailed to\b/i,
  /\bblocked\b/i,
  /\brefused\b/i,
  /\bno (?:commit|email|link|run)\b/i,
  /\bnot yet\b/i,
  /\bwithout (?:deploying|committing|sending)\b/i,
  /\b(?:i|we) (?:will|would|plan to|intend to|am going to|are going to)\b/i,
  /\bnext (?:turn|step|time)\b/i,
];

function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {{text: string, trace: Array<object>}} turn
 * @returns {Array<{kind: string, tools: string[], sentence: string}>} claims the
 *   trace does not support. Empty is the normal and expected result.
 */
export function unsupportedClaims({ text, trace = [] }) {
  const succeeded = new Set(
    (trace || []).filter((entry) => entry?.kind === 'action' && entry.ok).map((entry) => entry.tool),
  );

  const found = [];
  for (const sentence of sentences(text)) {
    if (NEGATED.some((re) => re.test(sentence))) continue;
    for (const claim of CLAIMS) {
      if (found.some((f) => f.kind === claim.kind)) continue; // one flag per kind
      if (!claim.patterns.some((re) => re.test(sentence))) continue;
      // Any successful action of the family vouches for the claim. The check is
      // "did nothing of this sort happen", not "does every sentence have its
      // own tool call" — the second would flag an accurate summary of three
      // commits as three separate lies.
      if (claim.tools.some((tool) => succeeded.has(tool))) continue;
      found.push({ kind: claim.kind, tools: claim.tools, sentence: sentence.slice(0, 200) });
    }
  }
  return found;
}

/** The line the founder reads. Null when there is nothing to say. */
export function describeUnsupportedClaims(claims) {
  if (!claims?.length) return null;
  return [
    `⚠ ${claims.length} claim${claims.length === 1 ? '' : 's'} in this report ${claims.length === 1 ? 'is' : 'are'} not backed by anything the team actually did:`,
    ...claims.map((c) => `  · Claims ${c.kind}, but no ${c.tools.join('/')} call succeeded this turn:\n    "${c.sentence}"`),
    'Treat those sentences as unverified. Everything else in the report stands.',
  ].join('\n');
}
