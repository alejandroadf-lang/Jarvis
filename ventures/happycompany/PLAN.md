# Happy Company: from repo to Marketplace revenue

Working name. Decision taken 28 September 2026: build on Atlassian Forge, list
for Jira Cloud and Confluence Cloud. This is the plan the agents and the founder
work from; the launch plan format follows `ventures/circadian/LAUNCH_PLAN.md`.

## Why this, why here

- Forge pays developers 100% of gross revenue until $1M lifetime (since
  January 2026), against 15–25% platform cuts elsewhere. No listing fee.
- Apps with no remotes and no egress carry the "Runs on Atlassian" badge, which
  is a filter enterprise buyers use. This app qualifies by construction.
- ISO 45003 and a growing set of national psychosocial-risk rules (Australia's
  2023 WHS regulations, Germany's Gefährdungsbeurteilung psychischer Belastung)
  oblige employers to identify hazards like excessive hours and workload. Jira
  and Confluence already contain the evidence; nobody has to fill in a survey.
- The founder's edge: an agent team that builds and tests, a hosting-free
  platform, and a product whose selling point is what it does *not* collect.

## The signals

`SIGNALS.md` is the catalogue: forty candidate signals across hours and
recovery, workload, fragmentation, deadline pressure, rework, withdrawal and
support, each with its evidence, false positives, privacy class and a
release. Decided 29 September 2026; steps 1 and 2 (twenty-two indicators
across five dimensions, including the sprint signals) are built and tested,
the rest waits for pilots.

## What exists today

The app in this directory: two product-event triggers, a daily scheduled
rollup, a page for Jira projects and Confluence spaces, pseudonymisation,
the 5-person rule, retention, twenty-two indicators in five ISO 45003-mapped
dimensions, "three things to change this week", holidays and per-signal
switches, 61 tests. Not yet done
on a real site: `forge register`, the first deploy, and confirming the
Confluence event payload shapes (README step 5).

## Competition on the Marketplace

- "AI Mental Health Support & Stress Burnout Insights for Jira" (listing
  1236271): individual-level tips and workload flags. Its individual framing is
  what works councils and EU employers object to; ours is the opposite.
- Workload and capacity apps (Tempo Capacity Planner, OBSS's workload tooling,
  ActivityTimeline): planning tools sold to PMs, not hazard reporting sold to
  HR and people managers. None map to ISO 45003 or offer a Confluence view.
- Survey tools (Officevibe, Culture Amp): outside Atlassian, self-report only.

Positioning: *"Team-level early warning for overwork, from the tools you
already use, with no surveys and no individual tracking."*

## Pricing

Per-user pricing through Atlassian billing (the Marketplace's user-based
model, Forge only): **$1 per user per month**, tiers by Jira user count, free
under 10 users. A 200-user site is $200 a month; 50 such customers is the
$10,000-a-month target. Atlassian bills and remits, so there is no Stripe,
no invoicing and no dunning to build.

Forge platform pricing (consumption-based since January 2026) is the cost
line to watch: each event is an invocation. The free allowance covers
development and early customers; at scale, the daily rollup stays cheap but
the per-event trigger may need a `filter.expression` to skip events that do
not change the counts (e.g. issue views, which the app does not subscribe to
anyway). Measure invocations per installation in the first month.

## The insurer track

Insurers cannot see individual health and do not want to. They can price a
group policy on a company's psychosocial-risk *management*. Two pathways:

1. **Germany**: § 20 SGB V obliges statutory health insurers to fund
   workplace health promotion, and the psychosocial risk assessment is a legal
   duty for every employer. A team-level report that documents identified
   hazards and their trend is exactly the evidence an insurer's occupational
   health unit can co-fund.
2. **Vitality-style programmes** (Discovery, AIA, John Hancock, Generali): they
   already discount premiums for measured behaviour. A "Happy Company" grade
   is a measured behaviour at company level.

Sequence: employers first (they buy the app), insurers in year two with
anonymised, aggregated results from consenting pilot customers. Do not sell
the insurer angle in the Marketplace listing; sell fewer late nights.

## 90 days

**Days 1–10: on a real site.** Founder creates the Atlassian developer account
and site; runs README steps 1–5; the agents fix whatever the Confluence
payloads turn out to need. Install on the founder's own Jira for the Jarvis
project. Take a daily screenshot for the listing.

**Days 11–30: three pilot teams.** Recruit through the founder's travel-tech
network and the Atlassian Community: teams of 8–40, one in Europe for the
works-council conversation. Free for six months in exchange for a monthly
30-minute call and permission to use anonymised results. Calibrate the bands
in `src/lib/score.mjs` against what the teams themselves say about the weeks
the app flags.

**Days 31–60: the listing.** Privacy & Security tab (the app's strongest
page: no egress, no text, 5-person rule, retention), five screenshots, a
two-minute video, pricing, the free tier. Submit; approval takes about two
to three weeks. Add `licensing.enabled: true` only at this step.

**Days 61–90: first paying customers.** Partner-directory and Community posts,
a page on the ISO 45003 duty per country, outreach to Atlassian Solution
Partners who run HR-adjacent implementations. Target by day 90: listing live,
3 pilots reporting, 5 paying sites.

## Day-90 decision rules

- Fewer than 3 pilot teams that keep the page open weekly → the signal is not
  useful enough; stop or re-scope to a Connect-replacement app (the fallback
  that was on the table).
- Pilots use it but no site pays at $1/user → try per-project pricing and the
  HR buyer instead of the engineering buyer, for 60 more days.
- 5 paying sites → hire nothing, spend on Marketplace ads, start the insurer
  conversations with the German pilot's data.

## Founder to-dos (only a human can)

- Atlassian developer account and Marketplace vendor profile (company name,
  support email, the postal address already in `COMPANY_POSTAL_ADDRESS`).
- `forge login` with an API token: the token stays on your machine.
- Decide the real product name before the listing (a trademark search first).
- Sign up one European pilot with a works council; their questions become the
  privacy page.

## Known gaps to close before the paid listing

- Confluence settings form has no space-admin check (Jira gates to project
  admins). Add a check through the space permissions API or hide the form
  for non-admins.
- Concurrent events in the same second can lose an increment (see the note
  at the top of `src/app.mjs`); use a KVS transaction per day key if a pilot
  team's volumes make it visible.
- Weekend-day input is a comma-separated field; replace with checkboxes.
- The mention event's field naming the mentioned account is assumed until
  the first `forge tunnel` run confirms it (README step 5).
- The trend uses the last four weeks; add a per-team baseline once pilots
  have eight weeks of data.
