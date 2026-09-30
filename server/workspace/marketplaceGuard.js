// A manifest change that can cost a listing its badge is the founder's call.
//
// For an Atlassian Forge app, adding a remote, a web trigger or an external
// (egress) permission can cost it the "Runs on Atlassian" badge, and that badge
// is part of why a security-conscious customer installs it. That is exactly the
// kind of change an agent should propose and not decide, and a pull request is
// already the proposal. What was missing is the founder being told which of
// their open pull requests is the one that matters. So opening a pull request
// that adds one of these to a manifest also puts a yes/no in the decision
// inbox. It does not block the pull request (nothing lands without a merge
// anyway); it makes sure the merge is a decision and not a reflex.

import { readFile } from '../deploy/github.js';
import { isWorkspaceConfigured } from './vault.js';
import { sendDecisionRequest } from './notebook.js';

const RISKS = [
  ['a remote', /^\s*remotes\s*:/m],
  ['a web trigger', /^\s*(-\s*)?webtrigger\s*:/m],
  ['an external (egress) permission', /^\s*(external|fetch|egress)\s*:/m],
];

/** What a manifest change newly adds, given the manifest it started from. Pure. */
export function manifestRisks({ newText, baseText }) {
  return RISKS.filter(([, re]) => re.test(newText || '') && !re.test(baseText || '')).map(([label]) => label);
}

export async function guardManifestChange({ venture, changes, pr, agentId }) {
  if (!isWorkspaceConfigured()) return null;
  const reasons = [];
  for (const c of changes) {
    if (c.deleted || !/(^|\/)manifest\.yml$/.test(c.path)) continue;
    let baseText = '';
    try {
      baseText = (await readFile({ owner: venture.repo.owner, repo: venture.repo.name, branch: venture.repo.branch, path: c.path })) || '';
    } catch {
      // Cannot read the base: treat everything in the new file as new, which
      // errs toward asking.
    }
    reasons.push(...manifestRisks({ newText: c.content, baseText }));
  }
  if (!reasons.length) return null;
  const what = [...new Set(reasons)].join(', ');
  return sendDecisionRequest(
    {
      title: `Pull request ${pr.number} adds ${what}`,
      question: `Merge pull request ${pr.number} on ${venture.title}, which adds ${what} to the manifest?`,
      recommendation: 'Do not merge until you have decided. Adding any of these can cost the app its Runs on Atlassian badge.',
      why: `The manifest change in "${pr.title}" adds ${what}. The pull request is at ${pr.url}. Listings with the badge are easier to sell to customers who vet security; check what the feature is worth before giving that up.`,
      ventureId: venture.id,
      expiresInDays: 14,
    },
    { agentId },
  );
}
