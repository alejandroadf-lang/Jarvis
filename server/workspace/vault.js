// The company's written output, as files the founder actually works in.
//
// Daily reports, weekly reflections and venture write-ups all lived in a web
// UI nobody re-reads. This publishes them as markdown into a GitHub repo the
// founder nominates — which both of their tools open natively:
//
//   Obsidian  — the repo *is* the vault, synced by a git plugin (SyncGit,
//               Obsidian Git, Vault Sync). Frontmatter drives properties and
//               search; [[wikilinks]] make the graph view show which reports
//               a venture came out of.
//   VS Code   — the same repo is just a folder. Markdown preview, real diffs,
//               and the whole history of what the company decided.
//
// One mechanism serves both because both are git-native, which is also why
// this reuses deploy/github.js rather than needing an Obsidian plugin or a
// local daemon. (Obsidian's Local REST API runs inside the app on the
// founder's machine — a server on Railway can never reach it.)
//
// Three properties, matching every other optional integration here:
//   - Opt-in. No WORKSPACE_REPO_OWNER/NAME, no calls, no behaviour change.
//   - Fail-quiet. A publish failure is logged and never breaks the cycle that
//     produced the report — the report is already saved and viewable.
//   - Kill-switch-aware. It writes to a real external system, so a founder
//     who halts real actions reasonably expects these writes to stop too.

import { commitFile, readFile, isGithubConfigured } from '../deploy/github.js';
import { getKillSwitch } from '../killSwitch.js';

// Where each kind of note lands. Folder names read as an Obsidian vault
// rather than a source tree, since that's the tool the founder thinks in.
const FOLDERS = {
  reports: 'Company/Daily Reports',
  reflections: 'Company/Weekly Reflections',
  ventures: 'Company/Ventures',
};

// The one file the founder writes and the company reads. Sitting at the top
// of the vault rather than inside Company/ because it belongs to them, not
// to the agents.
export const FOUNDER_NOTE_PATH = 'Steering.md';

// readFounderSteering() runs on every interactive chat turn, and a GitHub
// round-trip per message is a poor trade for a note the founder edits maybe
// once a week — it makes their chat slower and, if GitHub is having a bad
// day, makes them wait on it. Cached for a minute: long enough that a busy
// conversation costs one fetch, short enough that a steering change is live
// almost immediately.
const STEERING_TTL_MS = 60 * 1000;
let steeringCache = { text: null, at: 0 };

// For tests, and for the case where the founder wants their edit to land
// without waiting out the TTL.
export function invalidateSteeringCache() {
  steeringCache = { text: null, at: 0 };
}

export function workspaceConfig() {
  const owner = (process.env.WORKSPACE_REPO_OWNER || '').trim();
  const repo = (process.env.WORKSPACE_REPO_NAME || '').trim();
  const branch = (process.env.WORKSPACE_REPO_BRANCH || '').trim() || 'main';
  if (!owner || !repo) return null;
  return { owner, repo, branch };
}

export function isWorkspaceConfigured() {
  return Boolean(workspaceConfig()) && isGithubConfigured();
}

// Obsidian reads YAML frontmatter as note properties, so these become
// filterable fields rather than prose the founder has to scan for.
function frontmatter(fields) {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => (Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`));
  return `---\n${lines.join('\n')}\n---\n`;
}

// Obsidian resolves [[links]] by note name, so anything used as a link target
// has to survive as a filename. Strips what the filesystem or the linker
// would choke on, without mangling the title beyond recognition.
export function noteName(title) {
  return String(title || 'Untitled')
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Untitled';
}

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

export function formatDailyReport(report) {
  const ventureLinks = (report.proposedVentureNames || []).map((n) => `[[${noteName(n)}]]`);
  const body = [
    frontmatter({
      type: 'daily-report',
      date: report.date,
      revenue: Number(report.business?.revenue || 0),
      expenses: Number(report.business?.expenses || 0),
      net: Number(report.business?.net || 0),
      cost_usd: typeof report.costUsd === 'number' ? report.costUsd.toFixed(4) : undefined,
      tags: ['company/daily'],
    }),
    `# Daily Report — ${report.date}`,
    '',
    `Revenue to date ${money(report.business?.revenue)} · expenses ${money(report.business?.expenses)} · **net ${money(report.business?.net)}**`,
    '',
    '## Leadership Sync',
    '',
    report.leadership?.reply || '_(did not run)_',
    '',
    '## Opportunity Review',
    '',
    report.studio?.reply || '_(did not run)_',
  ];

  if (ventureLinks.length) {
    body.push('', '## Started today', '', ventureLinks.map((l) => `- ${l}`).join('\n'));
  }
  return body.join('\n') + '\n';
}

export function formatWeeklyReflection(reflection) {
  return [
    frontmatter({
      type: 'weekly-reflection',
      week_ending: reflection.weekEnding,
      reports_considered: reflection.reportsConsidered,
      tags: ['company/weekly'],
    }),
    `# Weekly Reflection — week ending ${reflection.weekEnding}`,
    '',
    `Based on ${reflection.reportsConsidered} daily report(s).`,
    '',
    reflection.reflection || '_(empty)_',
  ].join('\n') + '\n';
}

export function formatVenture(venture) {
  const milestones = (venture.milestones || [])
    .map((m) => `- [${m.status === 'done' ? 'x' : ' '}] ${m.title}${m.status === 'missed' ? ' — **missed**' : ''}`)
    .join('\n');

  return [
    frontmatter({
      type: 'venture',
      venture_id: venture.id,
      status: venture.status,
      created: (venture.createdAt || '').slice(0, 10),
      tags: [`venture/${venture.status}`],
    }),
    `# ${venture.title}`,
    '',
    venture.oneLiner || '',
    '',
    '## Why an agent-run company wins here',
    '',
    venture.agentNativeEdge || '_(not recorded — this venture predates the agent-native bar)_',
    '',
    '## The case',
    '',
    `**Problem.** ${venture.problem || '—'}`,
    '',
    `**Customer.** ${venture.targetCustomer || '—'}`,
    '',
    `**Model.** ${venture.businessModel || '—'}`,
    '',
    `**Market.** ${venture.marketSize || '—'}`,
    '',
    `**Path to $1M+.** ${venture.pathToMillions || '—'}`,
    '',
    '## Milestones',
    '',
    milestones || '_(none listed)_',
    venture.status === 'killed' ? `\n## Killed\n\n${venture.killReason || 'No reason recorded.'}` : '',
  ].join('\n') + '\n';
}

/**
 * Commits one note. Returns false rather than throwing on any failure —
 * every caller is a cycle that has already done its real work.
 */
async function publish(path, content, message) {
  if (!isWorkspaceConfigured()) return false;
  if (getKillSwitch().halted) {
    console.error('Workspace: skipping publish, real actions are halted.');
    return false;
  }

  const { owner, repo, branch } = workspaceConfig();
  try {
    await commitFile({ owner, repo, branch, path, content, message });
    return true;
  } catch (err) {
    console.error(`Workspace: failed to publish ${path}:`, err.message);
    return false;
  }
}

export function publishDailyReport(report) {
  return publish(
    `${FOLDERS.reports}/${report.date}.md`,
    formatDailyReport(report),
    `Daily report — ${report.date}`
  );
}

export function publishWeeklyReflection(reflection) {
  return publish(
    `${FOLDERS.reflections}/${reflection.weekEnding}.md`,
    formatWeeklyReflection(reflection),
    `Weekly reflection — week ending ${reflection.weekEnding}`
  );
}

export function publishVenture(venture) {
  return publish(
    `${FOLDERS.ventures}/${noteName(venture.title)}.md`,
    formatVenture(venture),
    `Venture — ${venture.title}`
  );
}

/**
 * What the founder wrote back. This is the half that makes it an integration
 * rather than an export: a note edited in Obsidian or VS Code, committed by
 * the git sync plugin, and read here into every agent's context on the next
 * turn. Empty on any failure, like every other context builder.
 */
export async function readFounderSteering() {
  if (!isWorkspaceConfigured()) return '';

  if (steeringCache.text !== null && Date.now() - steeringCache.at < STEERING_TTL_MS) {
    return steeringCache.text;
  }

  const { owner, repo, branch } = workspaceConfig();
  try {
    const text = await readFile({ owner, repo, branch, path: FOUNDER_NOTE_PATH });
    if (!text || !text.trim()) return cacheSteering('');

    // Strip frontmatter if the founder's editor added any — it's metadata for
    // Obsidian, not instruction for the company.
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    if (!body) return cacheSteering('');

    return cacheSteering(`Standing direction from the founder, written in their own notes
(${FOUNDER_NOTE_PATH} in the workspace repo) rather than said in this
conversation. Treat it as current priorities and constraints from them, and
where it conflicts with something older, this wins:
${body.slice(0, 4000)}`);
  } catch (err) {
    // Deliberately not cached: a transient GitHub failure shouldn't blind the
    // company to its own steering for the next minute.
    console.error('Workspace: failed to read founder steering:', err.message);
    return '';
  }
}

function cacheSteering(text) {
  steeringCache = { text, at: Date.now() };
  return text;
}
