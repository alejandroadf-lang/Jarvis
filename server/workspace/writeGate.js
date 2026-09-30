// One gate for every agent-written word that goes into the vault.
//
// The vault is a git repo, so what is written there is published and hard to
// erase: history keeps a deleted line, which matters for the two kinds of data
// this company touches: a person's sleep and heart readings (special-category
// health data) and employer and traveller details. It is also read back into
// agent prompts, and a note is a place for text from a web page or an email to
// wait until a later agent reads it as fact. Content screening cannot catch a
// plausible false note, so this is a floor and not a defence: it refuses what
// is unambiguous, names the rule so the agent can fix its text, and leaves the
// hard problem (untrusted text staying out of trusted context) to the trust
// tiers in notebook.js.
//
// It runs on agent text only. Pages the server builds from its own records
// are not passed through it.

const RULES = [
  [
    'a credential',
    /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.)/,
    'The vault is a git repo, so a secret written here is published. Remove it.',
  ],
  [
    'an email address',
    /[A-Z0-9._%+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}/i,
    'Keep contact details in the pipeline record and refer to a person by role or a pseudonymous id.',
  ],
  [
    'a phone number',
    /(?<![\w.])\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}(?![\w])/,
    'Leave the number out; say that a number is on file.',
  ],
  [
    'a WHOOP data field',
    /\b(recovery_score|hrv_rmssd|resting_heart_rate|sleep_performance|sleep_efficiency|skin_temp_celsius|spo2_percentage|strain_score)\b/i,
    "Wearable readings are health data about a person and stay out of the vault; write the aggregate (for example 'users slept 20 minutes longer on average') instead.",
  ],
  [
    'an image',
    /!\[[^\]]*\]\([^)]*\)|!\[\[|<img\b/i,
    "A remote image loads when the note is opened and can carry data out. Describe it in words.",
  ],
  [
    'executable code',
    /```\s*(dataviewjs|dataview|templater|js|javascript)\b|<%[*_-]?|<script\b|<iframe\b/i,
    "Plugins run notes' code with full access to the vault. Write plain text.",
  ],
  [
    'a link that carries data in its query string',
    /https?:\/\/[^\s)]+\?[^\s)]{60,}/,
    'Link to the page without the long query string.',
  ],
];

/** null when the text may be written, else a refusal that names the rule. */
export function checkVaultText(...parts) {
  const text = parts.filter((p) => typeof p === 'string').join('\n');
  for (const [name, pattern, fix] of RULES) {
    if (pattern.test(text)) return `Not saved: the text contains ${name}. ${fix}`;
  }
  return null;
}
