# Happy Company and ISO: what the app gives an auditor, and what it may claim

Psychosocial risk is now an audited topic. ISO 45001 has always required
hazard identification to include "social factors … and how work is
organised"; ISO 45003:2021 is the guidance on doing that for psychosocial
risk; national rules (Germany's §5 ArbSchG, the UK HSE Management Standards,
Australia's 2023 WHS regulations, France's DUERP, the Dutch RI&E, Belgium's
psychosocial risk law, Japan's stress check) require it outright. What an
auditor asks is the same everywhere: which hazards did you screen, how,
what did you find, what did you do, did workers take part, and what does
your method not cover.

Happy Company answers those questions for the part of work that happens in
Jira and Confluence, every week, and packs the answer each quarter.

## 1. What the app may claim, and what it may not

This section is the claims policy for the listing, sales material, and
anything a customer writes about the app. The code quotes the same lines.

| May say | May never say |
|---|---|
| "ISO 45003-aligned psychosocial risk screening" | "ISO 45003 certified" (ISO 45003 is guidance; nothing is certified against it) |
| "Evidence for ISO 45001 clauses 5.4, 6.1.2, 6.1.4, 7.4, 7.5, 8.1.2, 9.1.1, 9.3, 10.2, 10.3" | "ISO 45001 certified" or "makes you ISO 45001 compliant" (only an accredited certification body certifies an organisation's management system) |
| "Leading indicators in the sense of ISO 45004" | "Measures burnout" or "diagnoses" anything (it screens working conditions of teams; TERMS.md §5) |
| "Maps to the HSE Management Standards, GDA, Safe Work Australia, …" | "Satisfies" any of those laws (the employer's assessment does; the app is one input) |
| "Measuring / Acting / Sustaining: Happy Company levels" | That a level is a certificate, an ISO level, or independently verified |

Only organisations are certified, and only by an accredited body. The app
never certifies anyone and never implies it does.

## 2. Where each audit question is answered

The clause list lives in `src/lib/frameworks.mjs` (`ISO45001_EVIDENCE`) and
is printed in every evidence pack. In short:

| ISO 45001:2018 | What the auditor asks | Where the app answers it |
|---|---|---|
| 5.4 Consultation and participation | Were workers involved? | Consultation date recorded on the organisation page; the anonymous team pulse and its participation; the "What we measure" tab every employee can open |
| 6.1.2.1 Hazard identification | Did you screen how work is organised? | Weekly screening of 23 indicators and 4 enablers per team |
| 6.1.2.2 Risk assessment | How big is each risk? | Share of team-weeks at "act now" per hazard, with the trend inside the quarter |
| 6.1.4 Planning action | What did you decide to do? | Actions teams committed to from the week's suggestions |
| 7.4 Communication | How are results communicated? | Team page, weekly digest |
| 7.5 Documented information | Where is the record? | Audit trail and quarterly packs, three years |
| 8.1.2 Hierarchy of controls | Organisational controls or only resilience training? | Every suggestion changes how work is organised; none asks individuals to cope better |
| 9.1.1 Monitoring and measurement | Method? Bands? | Published method (`SIGNALS.md`), bands in `src/lib/score.mjs`, method version on every pack |
| 9.3 Management review | Input to the review? | The quarterly pack is written as a management review input |
| 10.2 Corrective action | What happened when it went wrong? | Teams at D or E for two weeks or more, their actions and whether they were done |
| 10.3 Continual improvement | Is it getting better? | Trends, recovery times, action completion, levels quarter on quarter |

## 3. The quarterly evidence pack

Built by `src/lib/evidence.mjs` from team-level figures only. It holds:
scope (teams, team-weeks, how many were too small to show); results (grades,
share of teams in sustainable conditions, median weeks to recover, teams that
needed support, alphabetically); every hazard screened with its attention
level and trend; actions and their completion; worker participation
(consultation, pulse responses per statement, never below five answers); the
mapping to eight frameworks, category by category, including what the app
does **not** cover; the ISO 45001 clauses; governance (settings changes and
switched-off signals from the audit trail); limits; the use ban; and a
reviewer sign-off line.

- **When it is built.** The current quarter is built live on request and
  marked as a draft. A closed quarter is packed once by the nightly job in the
  first three weeks of the next quarter (weekly figures are kept 26 weeks, so
  a pack built later would miss the quarter's first weeks) and kept three
  years, the length of a certification cycle.
- **Who sees it.** The same people as the organisation view: site
  administrators and the groups they name.
- **Where it goes.** Copy it as Markdown from the organisation page, or an
  administrator publishes it to a Confluence space as a page, once per
  quarter. Publishing needs Happy Company installed in Confluence on the same
  site.
- **Disclosure drafts.** Three drafts are generated from each pack for a
  person to edit: the ESRS S1 narrative on health and safety and work–life
  balance (it supports the narrative only; S1's datapoints are incidents and
  ill-health), Top Employers' Wellbeing domain, and B Corp's Fair Work
  question (B Lab asks for results by identity group, which the app does not
  and will not produce).

## 4. Framework coverage

`src/lib/frameworks.mjs` maps every signal to the hazard categories of ISO
45003, the HSE Management Standards, the German GDA work programme, Safe
Work Australia's code of practice, France (the Gollac report's six axes
used in DUERPs), the Netherlands (RI&E: work pressure and undesirable
behaviour), Belgium (the five domains of the psychosocial risk law) and
Japan's stress check. A test fails if any signal is unmapped, any category
has no signal, or a mapping points at a category that does not exist.

Every framework also lists what the app does not cover (violence and
harassment, recognition and career, job security, the physical environment,
emotional demands, and more). Those must be assessed another way, with
workers. The pack says so in its own text.

## 5. Lagging indicators: sickness absence and leavers

ISO 45001 9.1 and ISO 45004 expect leading indicators (what the grade is)
to be read alongside lagging ones. An administrator can import, per team
and closed quarter, headcount, sickness absence rate and leavers from the
HR system (`src/lib/outcomes.mjs`). The organisation page then shows the
organisation's absence and turnover, a rank correlation between each
team's grade in the quarter before and its absence (does the grade see it
coming?), and, when at least three teams sit on each side, the absence of
teams that spent a quarter mostly at D or E against the others. The
evidence pack carries the organisation's figures as its lagging indicators.

They never feed the grade (a team would look healthier because people
came in sick), are never shown per team, and teams under 10 people are
refused, because sickness absence is health data. No HR system is connected:
the app has no outside connections, so figures are pasted by hand.

## 6. Levels: Measuring, Acting, Sustaining

`src/lib/levels.mjs`. Judged on a quarter's pack. Provisional thresholds,
method `hc-2026.10`, set from the research rather than customer data; they
will be revisited after the pilots and the method version will move.

| Level | Every criterion of this level and the ones before |
|---|---|
| Measuring | Workers' representatives consulted and the date recorded; at least 80% of team-weeks large enough to show |
| Acting | At least 50% of teams committed to a change; at least 50% of closed actions done; at least 50% of teams run the anonymous pulse |
| Sustaining | At least 70% of teams at C or better at quarter end; teams back from D or E within 4 weeks (median; met when none needed to); and all of this two quarters in a row |

The organisation page shows each criterion as met or not yet, and what the
next level needs. Levels are for the organisation, never for a team or a
manager.

## 7. Signed attestations

`src/lib/attestation.mjs`. A site administrator can sign the level a closed
quarter reached. The statement carries the organisation name, product,
quarter, level, every criterion with its value, the headline figures, the
method version, the issue date, a validity to the end of the next quarter,
and this sentence: *self-attested by the app from work metadata; not a
certification and not an ISO certificate; independent verification is
recommended.*

- **Key.** One Ed25519 key pair per installation, generated on first use.
  The private key is kept in the Forge secret store and never leaves it; the
  public key and its id are shown on the organisation page and embedded in
  every attestation.
- **Checking one.** `node scripts/verify-attestation.mjs attestation.json
  <key id>` checks the signature offline, and that it was signed by the key
  whose id the organisation publishes. A changed figure, level or date fails.
- **What it proves.** That this installation issued exactly this statement.
  Not that the figures describe the organisation truthfully: the app sees
  Jira and Confluence metadata only.

## 8. ISO 45001's revision

ISO 45001 is under revision, with publication expected around 2027. The
drafts discussed publicly make psychosocial risk more explicit rather than
changing the management-system loop. Nothing here depends on the new text;
when it is published, the clause list in `frameworks.mjs` is updated against
it and the method version moves. Check the published standard, not this
paragraph.

## 9. What the customer still has to do

The app is a screening input to the psychosocial risk assessment, not the
assessment. The employer still has to consult workers (in Germany, agree a
works agreement: `WORKS_COUNCIL.md`), assess the hazards the app does not
cover, decide and resource the controls, hold the management review, and
keep the assessment itself. The pack is written to be attached to that
work, not to replace it.

## 10. Working with certification bodies

Certification bodies may not consult for the organisations they certify,
so they will not recommend a tool; their training arms and the auditors'
questions are what matter. What an auditor will look for in a pack: the
method and its limits stated, workers involved, controls that change how
work is organised, and a trend over more than one quarter. Partnerships
(training arms of certification bodies, German statutory health insurers'
workplace health programmes under §20b SGB V) are in `PARTNERSHIPS.md`.
