# Happy Company: Marketplace listing copy

Draft for the Atlassian Marketplace listing. Working name; replace after the
trademark search. Length limits follow the Marketplace form (tagline 130
characters, three highlights of about 45 words each, a full description).

## Tagline

Team-level early warning for overwork, with ISO 45003-aligned evidence. No
survey required, no individual tracking, nothing leaves Atlassian.

## Highlights

**See the strain before the sick note.** Happy Company grades each project
and space on hours and recovery, workload, fragmentation, deadline pressure
and rework, the psychosocial hazards ISO 45003 asks employers to manage.
Twenty-three indicators, one A–E grade, a twelve-week trend, and three things
to change this week.

**Built to be unable to watch anyone.** Every figure describes a team of
five or more. Account ids are replaced by a per-installation code, item ids
are hashed, per-person counts are deleted after 21 days, and no text is ever
read. There is no per-person view, no export and no outbound connection.

**Evidence your auditor will accept.** Every quarter the app packs what an
ISO 45001 audit or a national psychosocial risk assessment asks for:
hazards screened, what was found, what teams changed, worker participation,
mapped to ISO 45003 and seven national frameworks, with what it does not
cover. A works agreement template for the Betriebsrat ships with it.

## Description

Burnout does not start with a diagnosis. It starts with a team that ships at
23:00 every night, a quarter end where every ticket is High, one person who
carries half the work, sprints that never finish, and weekends that are not
weekends. Jira and Confluence already record all of it. Happy Company reads
the *when* and the *how much*, never the *what*, and turns it into a page
any manager can act on.

**What you see.** In every Jira project and Confluence space, a Team health
page: a grade from A to E, five dimension scores, plain-language indicators
("22% of activity happened outside working hours", "18% of sprint work was
carried over unfinished"), a twelve-week trend, and the three worst
indicators rewritten as one action each.

**Where the numbers come from.** Issue, page and comment events, reduced to
who (as a code), at what local hour, in which team. A daily snapshot of open
work: how it is spread, how much is in progress, overdue or marked urgent,
how the due dates bunch. Each closed sprint: committed, carried over,
created mid-sprint. Quiet hours use each person's own Jira time zone; public
holidays count as rest days.

**What it will never do.** Show anything about an individual. Read a comment
or a page. Send data outside Atlassian. Show a figure for fewer than five
active people. Let an administrator turn any of that off.

**Who it is for.** Engineering and product leaders who want to fix the
conditions rather than survey the symptoms. HR and people teams with a duty
to assess psychosocial risk (ISO 45003; § 5 ArbSchG in Germany; the 2023 WHS
regulations in Australia). Works councils who want a tool they can agree to.

**The Monday ritual.** Teams commit to one to three changes from the week's
suggestions, say a week later whether they happened, and earn badges for
improving, never for a grade. An optional weekly digest lands in the
project or space. Ask the Happy Company agent in Rovo "how are we doing and
what should we change?"

**When metadata is not enough.** An optional anonymous pulse asks what Jira
cannot see (respect, support, psychological safety, role clarity), one
statement per HSE Management Standard, shown only as counts and only for
five or more answers. Validation mode adds the Copenhagen Burnout Inventory
so you can check the grade against a validated scale.

**For HR and health and safety.** An organisation view with coverage, the
share of teams in sustainable conditions, recovery time and action
completion; teams that could use support in an alphabetical list, never a
ranking. The quarterly evidence pack, disclosure drafts for ESRS S1, Top
Employers and B Corp, your organisation's level (Measuring, Acting,
Sustaining: Happy Company's own, not a certification) and an attestation
signed so anyone can check it hasn't been edited.

**Holidays that are holidays.** Everyone can mark their own days away (no
reason asked, seen by nobody else), and the team page shows how much of the
team's time away was still spent working, the moment three or more people
are away.

**Day one.** In Jira, a project administrator can fill in the last three
weeks from issue history, so the first card appears the day you install.

**Pricing.** Per user, through Atlassian billing. Free under 10 users.

## Positioning (internal: never in the listing)

Marketplace copy must not disparage competitors. These are the facts to
use in conversations, all from `reports/Happy Company product enrichment.md`
(sources there).

| | Happy Company | Survey platforms (Culture Amp, Peakon, Officevibe, Yerbo) | Telemetry (Viva Insights, LinearB, Swarmia, Jellyfish) | Jira workload apps |
|---|---|---|---|---|
| Signal | Jira and Confluence metadata every week, optional pulse | What people say, per survey cycle | Calendar, chat or git | Assigned work |
| Unit shown | Team only, 5+ people, no per-person view for anyone | Groups above a threshold | Team views; LinearB flags a named developer | Per person |
| Needs a survey | No; the pulse is optional | Yes | No (Swarmia and DX add one) | No |
| Psychosocial compliance evidence | Quarterly pack mapped to ISO 45003 and 7 national frameworks, ISO 45001 clause evidence, attestation | Engagement reports | None found | None |
| Works council | Pack, clauses, signal switches, use ban in the licence | Varies | German templates exist for Viva | Rarely |
| Data leaves Atlassian | Never | Yes (their cloud) | Yes (their cloud) | Varies |
| Price | $1 per user per month today | About $4–5 per employee per month | Varies | Varies |

What not to claim: cross-customer benchmarks (the app has no egress, so it
publishes research-based reference bands instead), "detects stress" or
"measures burnout", or any certification.

## Screenshots to take (six)

1. The Team health page with a B grade and the three actions block, one committed.
2. The five dimensions expanded, mixed statuses.
3. The twelve-week trend chart after a hard quarter end.
4. The settings page with holidays and the signal switches.
5. The "too few people to show" state, because it is the promise.
6. The organisation page's evidence section: level criteria and hazards.

## Support and security fields

- Support: [support e-mail], response within two business days.
- Security: [security e-mail]; vulnerability reports answered within five
  business days.
- Privacy & Security tab: the answers in `WORKS_COUNCIL.md` §10.
- Documentation link: the README and `WORKS_COUNCIL.md` published on the
  vendor site.
