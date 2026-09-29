# Happy Company

Team load and burnout signals for Jira Cloud and Confluence Cloud. An Atlassian
Forge app: it runs on Atlassian's servers, stores nothing outside Atlassian, and
is listed on the Atlassian Marketplace.

It grades a **team** (a Jira project or a Confluence space), never a person, on
five of the psychosocial hazards ISO 45003 asks employers to manage:

| Dimension            | What it reads                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Hours and recovery   | Activity after hours, late at night, on weekends and holidays; long days; streaks; no week away |
| Workload and pace    | Concentration on one person, people far above the median open work, overdue, work in progress   |
| Fragmentation        | Different items and separate bursts per person-day, mention load                                |
| Deadline pressure    | Due dates bunching into one week, priorities inflated to High                                   |
| Rework               | Work reopened after being done                                                                  |

The grade (A–E), the five dimension scores, "three things to change this
week" and a 12-week trend appear on a "Team health" page in the project or
space. Admins set quiet hours, late night, weekend days, public holidays and
the long-day threshold, and can switch any signal off. The scoring bands are
starting points to be calibrated in pilots, and the page says so.

## The signals

`SIGNALS.md` lists every signal considered, what it means, where Jira or
Confluence records it, and whether it is built, proposed or refused. Read it
before adding a signal; the privacy classes there decide what may be stored.

## Layout

```
manifest.yml            modules, scopes, runtime — no remotes, no egress
src/index.js            Forge entry points: wiring only
src/app.mjs             the application, every dependency injected
src/storage.mjs         the KVS wrapper and an in-memory twin for tests
src/clients.mjs         the few Jira / Confluence REST calls
src/lib/time.mjs        local hour and weekday per zone, ISO weeks
src/lib/signals.mjs     day buckets: counts, active hours, item hashes, mentions
src/lib/recovery.mjs    streaks without a day off, and the week-away record
src/lib/privacy.mjs     pseudonyms, retention, the 5-person rule
src/lib/score.mjs       indicators → dimensions → grade, ISO 45003 mapping
src/lib/events.mjs      product event → {who, when, which team}
src/lib/openwork.mjs    the daily open-work snapshot (Jira)
src/frontend/index.jsx  the page, UI Kit
test/                   node:test, runs without Forge
```

## Privacy, in one paragraph

Account ids and item ids are hashed with a per-installation secret before
storage. Day buckets hold, per pseudonym, an action count, the hours of the
day that were active, the hashed items touched and a mention count, for 21
days; then they are deleted and weekly aggregates keep team shares only. One
record per team keeps three dates per pseudonym (first seen, last seen, last
five-workday rest) so that "no week away in three months" can be answered; a
person unseen for 120 days is dropped from it. Nothing is shown for a week
with fewer than five active people. The browser never receives per-person
data: `publicMetrics()` in `src/lib/privacy.mjs` is the only path out and it
copies team fields one by one. No issue key, title, text or field value is
ever stored. There is no outbound network call.

## Running it

Tests need only Node 22:

```
npm test
```

Deploying needs an Atlassian account, a free developer site for Jira and one
for Confluence (https://go.atlassian.com/cloud-dev), and the Forge CLI.

1. `npm install -g @forge/cli && forge login` — with an API token from your
   Atlassian account, never pasted anywhere else.
2. `npm install` in this directory, then `forge register` and put the printed
   app id into `manifest.yml` (the placeholder makes a deploy fail on purpose).
3. `forge lint` — it names any scope the modules need that the manifest lacks.
4. `forge deploy -e development`, then `forge install` once for Jira and once
   for Confluence on the developer site. Open a project → "Team health", and a
   space → "Team health".
5. `forge tunnel` and edit an issue, a page and a comment, and @mention
   someone in a Jira comment. The log shows each event; confirm the
   Confluence payloads carry the space, and the mention event carries the
   mentioned account, the way `src/lib/events.mjs` assumes (it documents what
   is verified and what is assumed). Adjust the normaliser if not; the tests
   describe every shape.
6. Leave it a week on a real team of five or more, then read the page.

Storage is per installation and Atlassian does not let the Jira copy read the
Confluence copy's data, so the two pages grade the same team from their own
product's activity. That is a platform rule, not a choice.

## What is deliberately not in v1

- Per-person views of any kind. Not a setting, not an admin option.
- Sentiment or text analysis of comments. Text is never read.
- An LLM. Nothing here needs one, and adding an outbound model call would
  forfeit the Runs on Atlassian badge.
- A space-admin check on the Confluence settings form (Jira gates settings to
  project administrators). The settings are display thresholds and a time
  zone; the gap is noted in PLAN.md.
