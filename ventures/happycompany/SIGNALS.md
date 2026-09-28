# Happy Company: the signals

**Status: proposal for agreement, written overnight 28–29 September 2026.**
Nothing beyond the v1 skeleton already in this directory gets built until the
rows below are agreed. Each signal has a *Proposed* column; add your decision
(keep / change / drop) and the agents build exactly that.

The person this is written for: someone working 8 to 12 hours a day, back to
back calls, team chats all day, deadlines, MBOs and OKRs. Their Jira and
Confluence work happens in the margins of that day, and that is precisely why
the two tools see the strain so clearly: the margins are where it lands.

---

## 1. What burnout is, and what a tool can honestly detect

**The definition.** The WHO's ICD‑11 classifies burn‑out as an occupational
phenomenon: "a syndrome resulting from chronic workplace stress that has not
been successfully managed", with three features: energy depletion or
exhaustion, mental distance or cynicism about the job, and reduced professional
efficacy. Those are the three scales of the Maslach Burnout Inventory, the
instrument most research uses.

**What causes it.** The Job Demands–Resources model, the best-supported
account, sorts every feature of a job into *demands* (workload, time pressure,
role conflict and ambiguity, emotional load) and *resources* (autonomy,
support, feedback). Meta-analyses find demands are the main driver of the
exhaustion component; missing resources drive the disengagement component;
and demands matter more than resources for burnout overall. Gallup's large
sample names the five strongest predictors in a manager's language: unfair
treatment, unmanageable workload, unclear communication, lack of manager
support, unreasonable time pressure. People who "always have too much to do"
are 2.2 times as likely to report frequent burnout.

**Why recovery is half the story.** Sonnentag's recovery research shows that
job demands, above all workload, reduce *psychological detachment* after work,
and that failing to detach predicts emotional exhaustion a year later.
Weekends matter for how the next week starts; the benefit of a vacation fades
within weeks if the everyday recovery is missing. Belkin, Becker and Conroy
found the mere *expectation* of answering after hours, not the minutes spent,
produces "anticipatory stress" and exhaustion.

**The health stakes.** The WHO/ILO joint estimate attributes 745,000 deaths
in 2016 to working 55 hours or more a week, which raises stroke risk by 35%
and fatal heart disease by 17% against a 35–40-hour week. 488 million people
were exposed.

**What the day looks like now.** Microsoft's 2025 Work Trend Index telemetry:
the average employee is interrupted every two minutes by a meeting, message or
notification; sends or receives more than 50 messages outside core hours;
meetings after 20:00 are up 16% year on year; 29% of active workers are back
in their inbox by 22:00. Gloria Mark's field studies: about 11 minutes on a
task before an interruption, about 23 minutes to fully return to it.

**Evidence that tool traces work.** Claes and colleagues (ICSE 2018) found
two thirds of developers keep office hours while a distinct cluster works
nights and weekends, and that commit timing correlates with bugs. Queen's
University's BurnRiSc built a monthly burnout-risk score from GitHub activity
timing and review participation: of ten developers who later publicly
disclosed burnout, six had a score above threshold 6 to 15 months earlier.

**So, honestly:** Jira and Confluence traces see *demands* and *missing
recovery* well (the exhaustion pathway), *efficacy* partly (rework,
carry-over, slipped deadlines), and *cynicism* barely, and then only as
withdrawal. They do not see calls, chats, email or calendars. Section 4 says
what to do about that. The app must never claim to detect burnout in a person;
it detects the *conditions* that produce it, in a *team*, early enough to act.

---

## 2. The 8-to-12-hour day, as Jira and Confluence record it

Take a team lead in a European or Asian office of a global company.

- **07:30** triage on the phone: a burst of issue updates and comments, all
  within ten minutes, across eight different issues.
- **09:00–17:30** calls. Jira activity in two-minute gaps between them: a
  comment here, a transition there, each on a different issue than the last.
- **17:30–19:00** the "real" work starts: page edits in Confluence, the design
  that could not be written between calls.
- **21:00–23:30** the second shift: the status page for tomorrow's steering
  call, the OKR check-in page, replies to the US team's comments.
- **Saturday** two hours to "get ahead". **Sunday evening** the week's plan.
- **Last ten days of the quarter**: everything above, doubled; a dozen issues
  suddenly due on the same Friday; priorities raised to High across the board.
- **No gap of five working days** in the last six months.

Every line above leaves a countable trace that needs no reading of any text:
a timestamp, an actor, an issue or page id, a status, a due date, a priority.
That is the whole input.

---

## 3. The catalogue

Columns: what it means · where it comes from · how it is computed at team
level · starting bands (good → poor) · evidence strength · false positives ·
privacy class · proposed release · **your decision**.

Privacy classes: **P0** counts only, no per-person field · **P1** per-pseudonym
counts inside a day bucket, deleted after 21 days · **P2** per-pseudonym data
across weeks (needs an explicit decision, see §6).

Releases: **v1** already built · **v1.1** buildable from the events and the
daily snapshot the app already receives, with a day-bucket schema change ·
**v2** needs new events, API calls or retention · **no** recommended against.

### A. Hours and recovery (exhaustion pathway; ISO 45003 "hours of work, schedule")

| # | Signal | Source | Team-level computation | Bands | Evidence | False positives | Privacy | Proposed | Decision |
|---|---|---|---|---|---|---|---|---|---|
| A1 | **After-hours share**: activity in quiet hours (default 20:00–07:00, each person's own Jira time zone) | issue and page event timestamps | after-hours actions ÷ all actions, per week | ≤8% → ≥25% | strong (Sonnentag, Belkin, Microsoft) | chosen split shifts (parents, the "triple peak" by choice); mitigated by A4 splitting late night out | P1 | v1, built | |
| A2 | **Weekend share** | same, weekend days per team setting | weekend actions ÷ all | ≤4% → ≥15% | strong (Sonnentag "the weekend matters") | Sun–Thu work weeks (setting exists); on-call rotas | P1 | v1, built | |
| A3 | **Long-span days**: person-days whose first and last action are ≥ 11 hours apart | first and last local hour per pseudonym per day | share of person-days with span ≥ 11 h | ≤10% → ≥35% | strong for hours (WHO/ILO 55 h); this is the direct "8 to 12 hours" signal | a 08:00 action and a 20:00 action with a free afternoon; still shows extended availability, which Microsoft's "infinite workday" data treats as the harm | P1 (two hours per pseudonym per day) | **v1.1** | |
| A4 | **Late-night share**: 22:00–05:00 local, weighted heavier than evening | as A1 | late actions ÷ all | ≤2% → ≥10% | strong (sleep; Claes bug link; Microsoft 22:00 inbox) | global teams with a chosen night owl | P1 | **v1.1** | |
| A5 | **No-recovery streaks**: people active 7 days in a row, or 12+ days without two consecutive days off | activity days per pseudonym across the 21-day window | share of active people in a streak this week | 0% → ≥30% | strong (detachment research) | trips with Jira triage from the airport count as work: correct | P1 (uses existing buckets) | **v1.1** | |
| A6 | **Vacation absence**: active people with no gap of ≥5 workdays in 90 days | requires remembering, per pseudonym, the date of the last 5-day gap | share of people without a gap | ≤20% → ≥60% | medium (Expedia: 65% vacation-deprived; recovery fade-out) | part-timers; people new to the team | **P2** (one date per pseudonym, 90 days) | v2, needs your call | |
| A7 | Activity during declared leave | Jira has no leave data | – | – | – | – | – | no | |

### B. Workload and pace (ISO 45003 "workload and work pace")

| # | Signal | Source | Computation | Bands | Evidence | False positives | Privacy | Proposed | Decision |
|---|---|---|---|---|---|---|---|---|---|
| B1 | **Concentration**: busiest person's share of activity above an even share | activity counts | topShare − 1/n | ≤10% → ≥35% | medium (unfair distribution; Gallup "unfair treatment") | a scrum master who touches every ticket; a bot account (exclude app users) | P1 | v1, built | |
| B2 | **Overloaded people**: ≥ 2× the team median open issues and ≥ 8 | daily JQL snapshot of unresolved issues | share of assignees over the line | 0% → ≥30% | strong (unmanageable workload, JD-R) | epics and umbrella tickets assigned to leads; mitigate by excluding issue types Epic/Initiative | P0 (snapshot keeps team figures only) | v1, built | |
| B3 | **Overdue share** | duedate in snapshot | overdue ÷ open | ≤8% → ≥30% | medium | teams that do not use due dates (indicator shows "no data", not 100) | P0 | v1, built | |
| B4 | **WIP per person**: issues in progress at once | snapshot, statusCategory = In Progress | mean in-progress per active assignee; share ≥ 5 | ≤2 → ≥5 | strong (multitasking, attention residue) | Kanban teams with explicit WIP limits will look good, correctly | P0 | **v1.1** | |
| B5 | **Assignment churn**: issues reassigned 2+ times | changelog `assignee` in update events | reassigned ÷ created, per week | ≤5% → ≥20% | medium (handoffs, role ambiguity) | triage queues that assign twice by design | P0 (count per issue hash, 21 days) | v2 | |
| B6 | **Unplanned work**: issues added to an active sprint | changelog `Sprint` while sprint active | added mid-sprint ÷ committed | ≤10% → ≥30% | medium (scope creep vs carry-over literature) | teams that plan continuously (Kanban): show as "not applicable" | P0 | **v1.1** (Scrum teams) | |
| B7 | **Sprint carry-over**: incomplete issues when a sprint closes | sprint closed event, or a daily poll of recently closed sprints (the event is reported unreliable) | incomplete ÷ committed | <10% → >20% | strong benchmarks (10–20% concerning, >20% a problem) | deliberately long-lived spikes | P0 | **v1.1** | |
| B8 | **Inflow vs outflow**: created vs resolved per week | created events; resolution from update events or snapshot | 4-week ratio | ≤1.1 → ≥1.5 | medium (backlog growth = pace pressure) | intake weeks after planning | P0 | **v1.1** | |

### C. Fragmentation and interruption (the "many calls, many chats" day)

| # | Signal | Source | Computation | Bands | Evidence | False positives | Privacy | Proposed | Decision |
|---|---|---|---|---|---|---|---|---|---|
| C1 | **Fragmentation**: distinct issues/pages touched per person-day, and number of separate activity bursts (gaps > 45 min) | hashed item id per event | median distinct items per person-day; share of person-days with ≥ 4 bursts | ≤4 items → ≥10; ≤2 bursts → ≥5 | strong (Mark: 23 min to refocus; Microsoft: interruption every 2 min) | triage roles (support leads) legitimately touch many items; show per role only if the team labels roles, otherwise accept | P1 (item hashes inside the day bucket) | **v1.1** | |
| C2 | **Comment bursts**: comments within 5-minute clusters across several issues | derived from C1 with kind = comment | share of comments in bursts | ≤20% → ≥50% | medium | stand-up follow-ups | P1 | v2 | |
| C3 | **Mention load**: @mentions received per active person per day | Jira `avi:jira:mentioned:issue` event (gives the mentioned account without reading text) | mentions ÷ active people ÷ day; concentration of mentions on one person | ≤3/day → ≥8/day; top person ≤ 25% → ≥ 50% | medium-strong (message load; Belkin's expectation effect) | announcement-style mentions of whole groups | P1 (count per pseudonym) | **v1.1**, Jira only (Confluence mentions need text) | |
| C4 | **Response pressure**: time from a mention to the mentioned person's next action on that issue | C3 plus per-issue pending state | median response lag; share under 15 min out of hours | – | medium (anticipatory stress) | – | P1, short-lived | v2 | |

### D. Deadline and goal pressure (MBOs, OKRs; ISO 45003 "time pressure")

| # | Signal | Source | Computation | Bands | Evidence | False positives | Privacy | Proposed | Decision |
|---|---|---|---|---|---|---|---|---|---|
| D1 | **Due-date crunch**: open issues due within the same 5-day window | duedate in snapshot | max 5-day density ÷ median density | ≤2× → ≥4× | medium (quarter-end and release crunch) | release trains by design; still a pressure period | P0 | **v1.1** | |
| D2 | **Slipped deadlines**: issues whose due date moved 2+ times | changelog `duedate` in update events | slipped ÷ issues with due dates | ≤10% → ≥35% | medium (unrealistic planning, Gallup time pressure) | roadmap grooming | P0 (per issue hash, 21 days) | **v1.1** | |
| D3 | **Quarter-end surge**: activity in the last 10 days of a quarter vs the quarter's weekly average | existing weekly totals | ratio | ≤1.3× → ≥2× | medium (MBO/OKR cycle) | fiscal years that do not end on calendar quarters (setting) | P0 | **v1.1** | |
| D4 | **Priority inflation**: open issues at High or Highest | priority in snapshot | share | ≤20% → ≥50% | medium (when everything is urgent, nothing is; unreasonable time pressure) | incident projects | P0 | **v1.1** | |
| D5 | **Blocked work**: flagged impediments | Jira `Flagged` field | flagged ÷ in progress | ≤10% → ≥30% | medium (low control) | – | P0 | v2 | |
| D6 | **Goal churn**: OKRs marked at risk / off track, goals per team | Atlassian Goals via Teamwork Graph API | – | – | – | – | – | v3: the API is Early Access, test organisations only | |
| D7 | Late edits to status/OKR pages by title | would require reading page titles | – | – | – | – | text | **no**; labels are metadata and could be an opt-in later | |

### E. Rework and efficacy (the "reduced professional efficacy" dimension)

| # | Signal | Source | Computation | Bands | Evidence | False positives | Privacy | Proposed | Decision |
|---|---|---|---|---|---|---|---|---|---|
| E1 | **Reopen rate**: Done → not Done transitions | changelog `status` with status categories (cached from the status API) | reopened ÷ resolved, 4 weeks | ≤5% → ≥15% | strong (rework literature; ~8% typical) | workflows that use Done as a review gate | P0 | **v1.1** | |
| E2 | **Cycle-time drift**: median in-progress→done vs the team's own 8-week baseline | changelog timestamps; start time per issue hash until done | ratio to baseline | ≤1.2× → ≥2× | medium | scope changes | P0 (issue hash → start, 90 days) | v2 | |
| E3 | **Edit churn** in Confluence: pages with many versions by many editors in a short span | `version.number` in page events | share of edited pages with ≥ 8 versions in 7 days | – | weak | living documents | P0 | v2 | |
| E4 | **Estimation miss**: points committed vs delivered | sprint API | – | – | medium | – | P0 | v2 (Scrum) | |

### F. Withdrawal (the cynicism pathway) — handle with care

| # | Signal | Source | Computation | Bands | Evidence | False positives | Privacy | Proposed | Decision |
|---|---|---|---|---|---|---|---|---|---|
| F1 | **Participation drop**: people whose activity fell > 60% for 3+ weeks while the team's did not | weekly counts per pseudonym over 6 weeks | share of previously active people who dropped | 0% → ≥25% | medium (BurnRiSc used review participation) | leave, role change, parental leave: indistinguishable | **P2** | v2 only if a works council would accept it; **default off**; or drop | |
| F2 | **Silent issues**: issues where only one person ever comments | comment events per issue hash | share of active issues | – | weak | solo work by design | P0 | v2 | |
| F3 | **Unread work** in Confluence: pages created that nobody else views within 14 days | Confluence analytics API (`/analytics/content/{id}/viewers`, classic scope) | share of new pages with ≤1 viewer | ≤20% → ≥50% | medium (isolation, futility → cynicism) | drafts, personal spaces (exclude) | P0 | v2 | |

### G. Support and single points of failure (ISO 45003 "support, role clarity")

| # | Signal | Source | Computation | Bands | Evidence | False positives | Privacy | Proposed | Decision |
|---|---|---|---|---|---|---|---|---|---|
| G1 | **Bus factor**: components or epics with a single active contributor | component / parent in events (metadata) | share of active components with one contributor | ≤20% → ≥50% | medium (isolation, no backup, no vacation possible) | tiny teams | P1 | v2 | |
| G2 | **Ownerless overdue work** | already in the snapshot (`unassigned`, overdue) | count and share | – | medium (team overwhelmed) | intake queues | P0 | **v1.1** (presentation only) | |
| G3 | Manager responsiveness | needs an org chart the app does not have | – | – | – | – | – | no | |

---

## 4. What Jira and Confluence cannot see

Calls, Slack or Teams, email, calendars. A Forge app without egress cannot read
them, and Atlassian does not expose Loom or Rovo chat activity. Three options:

1. **Say so, plainly, on the page.** The app measures the part of the day that
   lands in Jira and Confluence, and in the person from §2 that is where the
   overflow lands. Recommended for v1.x.
2. **Customer-managed egress to Google Calendar / Microsoft 365** for meeting
   load. Technically possible in Forge, but the app then loses the Runs on
   Atlassian badge for those customers and inherits calendar data. Not now.
3. **Teamwork Graph** (Atlassian's cross-tool graph, Early Access): connects
   Slack, Google Drive, GitHub and Goals for Rovo customers *inside*
   Atlassian's boundary. The right long-term route for meeting and chat load,
   when it leaves EAP. Watch it; do not build on it yet.

What the app refuses to do regardless: read comment or page text, sentiment,
or titles; show any per-person view; let a manager drill down; log hours;
infer leave.

---

## 5. Proposed v1.1 scoring

Five dimensions, equal weight, each the mean of its available indicators;
an indicator with no data is left out, never counted:

| Dimension | Indicators |
|---|---|
| Hours and recovery | A1, A2, A3, A4, A5 |
| Workload and pace | B1, B2, B3, B4, B7, B8 |
| Fragmentation | C1, C3 |
| Deadline pressure | D1, D2, D3, D4 |
| Rework | E1 |

Grade A–E as today, plus a **"three things to change this week"** block:
the three worst indicators rendered as sentences a manager can act on
("Half of this team's Jira work happens after 20:00. Which meeting could move
to make room for it in the day?"). The bands above are starting points; the
pilot plan calibrates them against what teams say about the weeks the app
flags. Everything remains a team indicator, never a diagnosis.

---

## 6. What the new signals cost in data

The day bucket today holds, per pseudonym, one number: actions. v1.1 adds:

| Field per pseudonym per day | Needed by | Retention |
|---|---|---|
| first and last active hour | A3 | 21 days, as today |
| set of hashed item ids touched | C1, C2 | 21 days |
| mentions received | C3 | 21 days |

Still no text, no issue keys, no names. Two signals need more and are
flagged **P2**: A6 (one "last gap" date per pseudonym, 90 days) and F1 (six
weekly counts per pseudonym). Both are still pseudonymous and team-reported,
but they are the first things a works council will ask about, so they are
off unless you decide otherwise.

Germany, where the insurer track starts: § 87 BetrVG gives the works council
co-determination over any technical system capable of monitoring behaviour or
performance, aggregated or not. So ship a **works-council pack** with the
app: what is collected, retention, the 5-person rule, the absence of any
individual view, and **per-signal on/off toggles for admins** so a council can
agree the exact set. That pack is also the Marketplace Privacy & Security tab.

---

## 7. Decisions for you

1. The seven groups A–G: any to strike entirely?
2. A3 long-span threshold: 10, 11 or 12 hours?
3. A4 late-night boundary: 22:00, or 23:00?
4. F1 participation drop: in with opt-in and default off, or out?
5. A6 vacation absence: accept the 90-day per-pseudonym date, or out?
6. C3 mentions Jira-only: fine, or drop mentions until Confluence can do it?
7. Per-signal admin toggles: yes (recommended), or one global switch?
8. The name. "Happy Company" is your phrase; keep it or change before the
   listing. A trademark search comes first either way.

---

## 8. Build order once agreed

| Step | Signals | What changes | Effort |
|---|---|---|---|
| 1 | A3, A4, A5, B4, C1, C3, D1, D4, E1, G2 | day-bucket schema (three fields), snapshot fields (in-progress, priority, due-date density), `mentioned` event, status-category cache, five-dimension scorecard, "three things" block, per-signal toggles | 2 agent-days, tests included |
| 2 | B6, B7, B8, D2, D3 | sprint changelog parsing, closed-sprint poll, created/resolved counts, due-date change counts, quarter setting | 1–2 agent-days |
| 3 | works-council pack, Privacy & Security tab text, listing copy | documents | 1 agent-day |
| v2 | A6, B5, C2, C4, D5, E2, E3, F2, F3, G1 | each its own PR after pilots ask | as needed |
| watch | D6, Teamwork Graph | when it leaves Early Access | – |

The v1 code is a foundation for this, not a commitment: every signal above
slots into the existing bucket → metrics → scorecard path, and the tests
already cover that path end to end.

---

## Sources

- WHO, *Burn-out an "occupational phenomenon"*, ICD-11 (2019): https://www.who.int/news/item/28-05-2019-burn-out-an-occupational-phenomenon-international-classification-of-diseases
- Bakker & Demerouti, JD-R theory, *Annual Review of Organizational Psychology* (2023): https://www.annualreviews.org/content/journals/10.1146/annurev-orgpsych-120920-053933
- Gallup, *Employee Burnout, Part 1: The 5 Main Causes*: https://www.gallup.com/workplace/237059/employee-burnout-part-main-causes.aspx
- Sonnentag & Fritz, stressor-detachment model, *Journal of Organizational Behavior* (2015): https://onlinelibrary.wiley.com/doi/abs/10.1002/job.1924
- Belkin, Becker & Conroy, *Exhausted, but Unable to Disconnect* (2016): https://source.colostate.edu/anticipatory-stress-of-after-hours-email-exhausting-employees/
- WHO/ILO, *Long working hours increasing deaths from heart disease and stroke* (2021): https://www.who.int/news/item/17-05-2021-long-working-hours-increasing-deaths-from-heart-disease-and-stroke-who-ilo
- Microsoft Work Trend Index, *Breaking down the infinite workday* (2025): https://www.microsoft.com/en-us/worklab/work-trend-index/breaking-down-infinite-workday
- Mark, Gudith & Klocke, *The Cost of Interrupted Work* (2008), summarised: https://www.fastcompany.com/944128/worker-interrupted-cost-task-switching
- Claes, Mäntylä, Kuutila & Adams, *Do programmers work at night or during the weekend?* (ICSE 2018) and *TGIF: the evolution of developer commit times* (2025): https://link.springer.com/article/10.1007/s10664-025-10767-2
- BurnRiSc, developer burnout signals from GitHub activity (Queen's University): https://blog.pebblous.ai/blog/developer-burnout-signals-github-activity/en/
- Sprint carry-over benchmarks: https://www.minware.com/guide/metrics/sprint-rollover-rate
- Atlassian State of Teams 2025: https://www.atlassian.com/blog/state-of-teams-2025
- Forge Jira events (mentioned, worklog, sprint) and Confluence analytics API: https://developer.atlassian.com/platform/forge/events-reference/jira/ , https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-analytics/
- Teamwork Graph API (EAP): https://developer.atlassian.com/platform/forge/call-the-teamwork-graph-api/
- Works councils and monitoring systems in Germany (§ 87 BetrVG): https://www.heuking.de/en/news-events/newsletter-articles/detail/data-protection-and-the-works-council.html
