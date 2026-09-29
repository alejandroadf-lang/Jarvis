# Happy Company: does the grade track burnout? The validation protocol

The bands behind the grade are research-based starting points
(`SIGNALS.md`). Before the grade is sold as more than that, or any public
badge says anything about burnout, it has to be shown to go with something
validated. This is the protocol, written before any data exists so the
result cannot be tuned to it. It is for the pilots, and for the auditor,
insurer or researcher who asks how the method was checked.

## Question

Across teams, do teams with better Happy Company grades report less
work-related burnout on a validated scale?

## Measures

- **Grade score** (0–100), the mean of the team's weekly scores over the
  five weeks before the pulse period closes. From `computeTeam`.
- **Work-related burnout**, the seven-item work-related scale of the
  Copenhagen Burnout Inventory (Kristensen et al., 2005), asked in the team
  pulse when validation mode is on (`CBI_ITEMS`, `src/lib/pulse.mjs`),
  scored 0–100 as published, one reversed item. The CBI is free to use.
- **Sickness absence** (secondary), where the organisation imports it: each
  team's absence rate in the quarter after the grade quarter, teams of 10 or
  more (`src/lib/outcomes.mjs`). This asks whether the grade sees absence
  coming, which is the claim buyers care about most.
- **Face validity**, the pulse statement "The grade on our team page matches
  how the last few weeks felt" (1–5).

All are linked only at team level. By design the app cannot link a
person's pulse answer to their activity, and the protocol does not try.

## Design

Observational, two quarters, at least 8 teams across at least 2
organisations (the analysis needs 5 teams to report anything; 8 leaves room
for suppression). Monthly pulse with validation mode on. No intervention
beyond what every customer gets. Works council or employee representatives
consulted before start in every organisation that has one.

## Hypotheses and thresholds, fixed now

1. Spearman's rho between grade score and CBI score is negative.
2. Primary: rho ≤ −0.3 (moderate or stronger agreement) at the end of the
   second quarter.
3. Face validity: mean agreement with the match statement ≥ 3.5 of 5.
4. Secondary: where absence is imported, rho between a quarter's grade
   score and the next quarter's absence rate ≤ −0.3. Absence has many
   causes outside work, so a weaker result here does not overturn a good
   primary result; it is reported beside it.

The organisation view computes rho and the verdict with the thresholds in
`src/lib/validation.mjs` (≤ −0.5 strong, ≤ −0.3 moderate, < 0 weak, else
none) and says "needs at least 5 teams" until it has them.

## What happens with each result

- **Moderate or strong.** Publish the method and the result (teams, rho,
  period), keep the bands, and allow the claim "the grade tracks reported
  work-related burnout (rho = …, n = … teams)". Still never "measures
  burnout" or "detects stress".
- **Weak.** Look at which dimensions track and which do not (a per-dimension
  rho is a small addition to `validationSummary`), recalibrate those bands,
  move the method version, run another quarter.
- **None or positive.** Say so to the pilots, stop using the grade in sales
  material beyond "working-conditions screening", and recalibrate before
  any further claim.

A null result is published too.

## Limits to state with any result

Few teams; teams are not a random sample; the pulse measures the people who
answer; metadata sees only Jira and Confluence; burnout has causes outside
work that no team grade can see; a correlation across teams says nothing
about any individual. The study checks the grade as a screening signal for
teams, which is all it claims to be.

## Data handling

Nothing leaves the customers' Atlassian sites. Each organisation reads its
own rho on the organisation page and sends the vendor three numbers (teams,
rho, match mean) by e-mail if it agrees to take part in the pooled result.
Pooling is by hand, never by the app, which has no outbound connection.
