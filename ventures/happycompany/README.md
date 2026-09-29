# Happy Company

Team load and burnout signals for Jira Cloud and Confluence Cloud. An Atlassian
Forge app: it runs on Atlassian's servers, stores nothing outside Atlassian, and
is listed on the Atlassian Marketplace.

It grades a **team** (a Jira project or a Confluence space), never a person, on
five of the psychosocial hazards ISO 45003 asks employers to manage:

| Dimension            | What it reads                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Hours and recovery   | Activity after hours, late at night, on weekends and holidays; long days; streaks; no week away; work on days marked away |
| Workload and pace    | Concentration, people far above the median open work, overdue, work in progress, sprint carry-over, inflow vs outflow |
| Fragmentation        | Different items and separate bursts per person-day, mention load                                |
| Deadline pressure    | Due dates bunching, priorities inflated to High, work created mid-sprint, due dates moved, load surge |
| Rework               | Work reopened after being done                                                                  |

The grade (A–E), the five dimension scores, "three things to change this
week", what would lift the grade to the next letter, and a 12-week trend
appear on a "Team health" page in the project or space. The team commits to
the changes it will try, says a week later whether they happened, and earns
badges for improvement (never for a grade level). A "What we measure" tab
tells every employee what is and is not counted, and states the use ban in
`TERMS.md`.

Teams can turn on a weekly digest, posted every Monday as a Jira issue or a
Confluence blog post. HR, health and safety and leadership get an
organisation view (Jira: "Working conditions across teams"; Confluence:
global settings) with coverage, the share of teams in sustainable
conditions, recovery time, action completion, the teams that could use
support (alphabetical, never ranked) and a cost-of-strain calculator that
uses only the customer's own assumptions.

An optional anonymous team pulse (monthly or quarterly) asks what metadata
cannot see: respect, psychological safety, support, role clarity, control
and change, one statement per HSE Management Standard. Answers are kept
only as counts and shown only for closed periods. Validation mode adds the
Copenhagen Burnout Inventory so the grade can be checked against a
validated scale across teams. A separate enablers score shows what helps:
blocked work, priority churn, work people pick up themselves, and work only
one person touches. Every quarter the organisation view packs the evidence an ISO 45001
auditor or a national psychosocial risk assessment asks for (`ISO.md`):
hazards screened, what was found, what was done, whether workers took part,
mapped to ISO 45003 and seven national frameworks, with what the app does
not cover. It shows the organisation's level (Measuring, Acting,
Sustaining, Happy Company's own and never a certification), drafts ESRS S1,
Top Employers and B Corp text, and lets an administrator sign an
attestation anyone can check offline. In Jira, a project administrator can
fill in the last three weeks from issue history so the first card appears
on day one.

HR can paste each team's sickness absence rate and leavers once a
quarter. The app checks whether the grade saw the absence coming, feeds
the cost estimator the organisation's own figures and adds them to the
evidence pack as lagging indicators. They never change a grade, never
appear per team, and teams under 10 people are refused.

Admins set quiet hours, late night, weekend days, public holidays and
the long-day threshold, and can switch any signal off. The scoring bands are
starting points to be calibrated in pilots, and the page says so.

## The signals

`SIGNALS.md` lists every signal considered, what it means, where Jira or
Confluence records it, and whether it is built, proposed or refused. Read it
before adding a signal; the privacy classes there decide what may be stored.

`WORKS_COUNCIL.md` is the pack for a customer's works council and data
protection officer: what is collected, retention, the protective rules, the
legal basis, draft clauses for a works agreement, the employee notice and
the Marketplace Privacy & Security answers.

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
src/lib/shape.mjs       development-only log of event structure, never values
src/lib/progress.mjs    what would lift the grade to the next letter
src/lib/badges.mjs      improvement badges and action streaks with freeze weeks
src/lib/transparency.mjs  what is measured, never measured, and the use ban
src/features/actions.mjs  the commit-and-close action loop
src/features/audit.mjs  the audit trail (ISO 45001 7.5), 3 years
src/features/digest.mjs the weekly digest, posted once per completed week
src/features/org.mjs    the organisation view: coverage, recovery, action, no ranking
src/lib/digest.mjs      the digest text
src/lib/cost.mjs        the cost-of-strain scenario calculator
src/lib/pulse.mjs       the anonymous pulse: statements, counts, the burnout scale
src/lib/validation.mjs  grade against burnout scale, rank correlation
src/lib/enablers.mjs    what helps: blocked work, churn, self-assignment, solo work
src/features/pulse.mjs  pulse storage: counts only, per-period voter codes
src/frontend/org.jsx    the organisation page
src/lib/sprints.mjs     carry-over and unplanned work per closed sprint (Jira)
src/lib/frameworks.mjs  every signal mapped to ISO 45003 and seven national frameworks
src/lib/evidence.mjs    the quarterly psychosocial-risk evidence pack
src/lib/disclosures.mjs ESRS S1, Top Employers and B Corp drafts from a pack
src/lib/levels.mjs      Measuring, Acting, Sustaining
src/lib/attestation.mjs signed attestations of a level (Ed25519)
scripts/verify-attestation.mjs  checks an attestation offline
src/lib/away.mjs        days each person marks away, and work done on them
src/lib/outcomes.mjs    imported sickness absence and leavers: parsing, checks, no per-team output
src/rovo.mjs            the Rovo agent's two read-only actions
src/lib/brief.mjs       the team page condensed for Rovo
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

`test/manifest.test.mjs` fails if the code handles a product event the
manifest does not subscribe to, or the other way round, or if the manifest
gains any egress. The manifest also passes Atlassian's own validator
(`@forge/manifest`, the one `forge lint` uses); `forge lint` itself needs a
login, so run it once after `forge login`.

Deploying needs an Atlassian account, a free developer site for Jira and one
for Confluence (https://go.atlassian.com/cloud-dev), and the Forge CLI.

### Deploying from GitHub (no laptop)

`.github/workflows/happycompany-deploy.yml` runs the Forge CLI in GitHub
Actions. Set up once, from a browser:

1. Create the app in the developer console
   (https://developer.atlassian.com/console/myapps → Create → Forge app) and
   copy its App ID (`ari:cloud:ecosystem::app/…`). If the console does not
   offer it, `forge register` run once anywhere prints the same id.
2. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens.
3. In the GitHub repo, Settings → Secrets and variables → Actions: secrets
   `FORGE_EMAIL` (the account's e-mail) and `FORGE_API_TOKEN` (the token);
   variable `FORGE_APP_ID` (the App ID). The token goes there and nowhere
   else: not a chat, not a commit.
4. Actions → "Happy Company deploy" → Run workflow: environment `staging`,
   `install_site` your developer site (`you.atlassian.net`). It tests, lints,
   deploys and installs in Jira and Confluence.

After that, every merge to `main` that touches `ventures/happycompany/`
deploys to **staging** by itself. **Production** is only ever a manual run
choosing it: it is other companies' Jira. Give the `forge-production`
environment a required reviewer (Settings → Environments) so even a manual run
waits for you. The workflow never runs on pull requests, since the agents
propose their work as pull requests and a pull request's code would run with
the token in reach; `test/deployWorkflow.test.mjs` pins both rules. Without the
secrets, a push deploy is skipped with a note and a manual run fails naming
what to set.

The id is written into the manifest only inside the job, so the placeholder
stays in the repo. Step 5 below (the event-shape check) still wants the CLI:
`forge variables` and `forge logs` are run by hand.

### Deploying from a laptop

1. `npm install -g @forge/cli && forge login` — with an API token from your
   Atlassian account, never pasted anywhere else.
2. `npm install` in this directory, then `forge register` and put the printed
   app id into `manifest.yml` (the placeholder makes a deploy fail on purpose).
3. `forge lint` — it names any scope the modules need that the manifest lacks.
4. `forge deploy -e development`, then `forge install` once for Jira and once
   for Confluence on the developer site. Open a project → "Team health", and a
   space → "Team health".
5. Confirm the event shapes. Turn on the development-only shape log,
   redeploy, then use the site from any browser, a phone included:

   ```
   forge variables set --environment development HAPPYCOMPANY_LOG_SHAPES 1
   forge deploy -e development
   ```

   On the site: edit an issue, comment on it and @mention someone, edit a
   Confluence page and comment on it, open "Team health" in a project and
   in a space, and save settings once as an admin and once as a plain
   member. Then:

   ```
   forge logs -e development --since 30m
   ```

   Each event logs its structure (every key path and its type, never a
   value; see `src/lib/shape.mjs`). That confirms the three things
   `src/lib/events.mjs` and `src/clients.mjs` assume but could not verify
   without a site: which field of a Confluence event carries the space,
   which field of the mention event names the mentioned account, and that
   `include-operations=true` returns the viewer's space permissions. Turn it
   off afterwards with `forge variables unset --environment development
   HAPPYCOMPANY_LOG_SHAPES` and deploy again. Never set it in production.
   (`forge tunnel` shows the same thing live, if you prefer a terminal.)

   Then let the daily job run once (or temporarily set the scheduled
   trigger's interval to `fiveMinute`) and look in `forge logs` for a line
   starting `[happycompany] rollup` with an empty `errors` list. An error on
   the `sprints` step means the site's Jira Software API wants a scope the
   manifest lacks; that step fails on its own and nothing else is affected.
6. Leave it a week on a real team of five or more, then read the page.

Storage is per installation and Atlassian does not let the Jira copy read the
Confluence copy's data, so the two pages grade the same team from their own
product's activity. That is a platform rule, not a choice.

## What is deliberately not in v1

- Per-person views of any kind. Not a setting, not an admin option.
- Sentiment or text analysis of comments. Text is never read.
- An LLM of our own. Nothing here needs one, and adding an outbound model
  call would forfeit the Runs on Atlassian badge. The Rovo agent uses
  Atlassian's own AI, inside Atlassian, and sees only what the team page
  shows.
- Cross-customer benchmarks. Pooling customers' figures needs egress and
  small cohorts can be re-identified, so the app publishes research-based
  reference bands (`SIGNALS.md`) instead. Validation results are pooled by
  hand, three numbers per customer, only with consent (`VALIDATION.md`).
