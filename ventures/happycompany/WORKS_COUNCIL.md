# Happy Company: the works-council pack

For the works council (Betriebsrat), the data protection officer and the HR
lead of a company that wants to install Happy Company in Jira Cloud or
Confluence Cloud. Written to answer, in one reading, the questions § 87 (1)
No. 6 of the German Works Constitution Act (BetrVG) and Article 88 GDPR with
§ 26 BDSG make you ask. It doubles as the source for the Atlassian Marketplace
Privacy & Security tab. Everything here is checkable in the code, which is
open to the customer on request; file names are given so an auditor can look.

## 1. What the app is, in three sentences

Happy Company grades a **team** (a Jira project or a Confluence space) on the
working conditions that produce burnout: hours and recovery, workload,
fragmentation, deadline pressure and rework, the psychosocial hazards
ISO 45003 asks employers to manage. It reads *when* and *how much* work
happens in Jira and Confluence, never *what* the work is or *what anyone
wrote*. It shows nothing about any individual, and it is built so that it
cannot, not merely configured so that it does not.

## 2. Co-determination: yes, it applies

A system that processes data about employees' behaviour is a technical
device within § 87 (1) No. 6 BetrVG even when it only reports aggregates. So
the app should be introduced through a works agreement
(Betriebsvereinbarung). Section 8 gives the clauses. The app's per-signal
switches exist so that the agreed set of signals is the set the software
computes: what the council did not agree to is not stored, not scored and
not shown.

## 3. What is collected

Every fact the app stores, and where in the code it is written:

| Fact | Granularity | Where |
|---|---|---|
| An action happened (an issue created, updated or commented; a page or blog post created or updated; a comment made) | count per team per day | `src/lib/signals.mjs`, `recordActivity` |
| It happened in quiet hours, late at night, on a weekend day or holiday | count per team per day | same |
| Its kind: created, updated, comment, resolved, reopened; and whether a due date was moved | count per team per day | same |
| Who acted, as a **pseudonym** (see §4) | count per pseudonym per day | same |
| Which **hours of the day** the pseudonym was active | up to 24 values per pseudonym per day | same |
| Which **items** the pseudonym touched, as short hashes | up to 200 hashes per pseudonym per day | same |
| How many times the pseudonym was @mentioned (Jira) | count per pseudonym per day | `recordMention` |
| Per pseudonym: first day seen, last day seen, last day a five-workday gap ended | three dates per pseudonym per team | `src/lib/recovery.mjs`, `updatePeopleRecord` |
| A cached time zone per pseudonym (from the Jira profile) | one string per pseudonym | `src/app.mjs`, `zoneFor` |
| Open work, once a day: how many issues, how many with a due date, unassigned, overdue, marked High; how unevenly they are spread; how many in progress per assignee | team totals and shares only | `src/lib/openwork.mjs` |
| Per closed sprint: committed, carried over, created mid-sprint | four numbers per sprint | `src/lib/sprints.mjs` |
| Team settings: time zone, quiet hours, late hours, weekend days, holidays, long-day threshold, minimum group size (5 to 10), which signals are on | per team | `src/app.mjs`, `validateSettings` |
| Actions the team committed to and whether they happened, with no record of who committed or closed them | per team per week | `src/features/actions.mjs` |
| Launch or incident weeks the team marked | up to 2 a quarter | `src/features/actions.mjs` |
| Audit trail: settings changes (with the administrator's pseudonym), committed and closed actions (with nobody's) | 3 years | `src/features/audit.mjs` |

### What is never collected

- Issue keys, summaries, descriptions, comment text, page titles or bodies.
- Names, e-mail addresses or Atlassian account ids in clear.
- Timestamps. The app keeps the hour of the day, not the minute or second.
- Anything from Slack, Teams, e-mail, calendars or any system outside Jira
  and Confluence. The app has no network access outside Atlassian.
- Anything about people who merely view the page.

## 4. Pseudonymisation

On first use in each customer installation the app generates a random
256-bit key and keeps it in Atlassian's secret store for that installation
(`src/lib/privacy.mjs`, `newSalt`). Every account id is replaced by the first
16 hex characters of SHA-256 over key and id before it is stored
(`pseudonym`). Item ids are hashed the same way with a different prefix
(`itemHash`).

Consequences: the same person has a different pseudonym in every customer
installation; the vendor never sees the key, which never leaves Atlassian;
and re-identification would require both the key and a list of account ids to
try. The app itself holds no such list. Under GDPR this is pseudonymised
personal data, not anonymous data, and it is treated as such below.

## 5. Retention

| Data | Kept for | Then |
|---|---|---|
| Day buckets (everything per pseudonym per day) | 21 days | deleted by the daily job (`RETAIN_DAYS`) |
| Weekly aggregates (team shares only, no pseudonyms) | 26 weeks | deleted (`RETAIN_WEEKS`) |
| Open-work snapshots (team figures) | 91 days | deleted |
| Sprint summaries (four numbers) | 182 days | deleted |
| Time zone cache | 30 days | deleted |
| People record (three dates per pseudonym) | while the person is active; a pseudonym unseen for 120 days is removed | removed (`FORGET_AFTER_DAYS`) |
| Everything | on uninstall | Atlassian removes the app's storage with the installation |

## 6. The rules that protect individuals

1. **Team level only.** Nothing is shown for a week in which fewer than five
   people were active (`MIN_GROUP`); a team may raise its own threshold to
   ten. Below it, a share points at someone. Every share that reaches the
   screen is rounded to the nearest 5%, so one person's action in a small
   team rarely moves a displayed figure.
2. **One path to the screen.** `publicMetrics()` in `src/lib/privacy.mjs` is
   the only function whose output reaches the browser, and it copies team
   fields one by one. A per-person field cannot leak by omission.
3. **No drill-down.** There is no per-person view, no filter by person, no
   export, no API. Not as a setting, not for administrators.
4. **No text.** The app subscribes to events and reads their metadata. It
   never requests a comment or page body.
5. **Purpose limitation in code.** The only consumer of the data is the Team
   health page in the project or space it describes. Nothing is sent
   anywhere: the app declares no remote endpoints and no egress permission,
   which is what Atlassian's "Runs on Atlassian" badge certifies.
6. **Per-signal switches.** Each of the twenty-two indicators can be switched
   off by a project administrator; a switched-off indicator leaves the score
   and its data is still counted only as part of the team totals.

## 7. Legal basis and roles

- The customer is the **controller**. The vendor provides software that
  runs on Atlassian's infrastructure inside the customer's Atlassian
  tenancy and does not receive the data; the vendor is therefore not a
  processor of the customer's employee data. Atlassian remains the
  customer's processor under the customer's existing Atlassian agreement,
  and the app inherits the customer's Atlassian data residency.
- Legal basis for processing: the works agreement under Article 88 GDPR
  and § 26 (4) BDSG, or, absent a works council, Article 6 (1)(f) GDPR with
  the employer's duty to assess psychosocial risks (§ 5 (3) No. 6 ArbSchG)
  as the legitimate interest. A data protection impact assessment is
  recommended because the processing concerns employees; §3 to §6 of this
  document are its input.
- **Employee information** (Articles 13/14 GDPR): a one-page notice, §9.

## 8. Draft clauses for the works agreement

Numbered so they can be adopted as they are or struck one by one.

1. **Purpose.** Happy Company is used solely to identify, at team level,
   working conditions that present psychosocial risks (excessive hours,
   missing recovery, workload, fragmentation, deadline pressure, rework),
   in order to improve them. Any other use is prohibited.
2. **Prohibition of individual evaluation** (Auswertungsverbot). The data
   shall not be used to assess, compare, rank, pay, reward, promote,
   discipline or dismiss any employee, nor as an input to bonus, variable
   pay, performance review, calibration or redundancy selection, nor to draw
   conclusions about an individual's performance or behaviour. A team's
   grade shall not be used as a mark on its manager. The employer confirms
   that the software offers no such function; the same ban is a condition
   of the vendor's licence (`TERMS.md` §1) and is shown to every employee on
   the "What we measure" tab.
3. **Minimum group size.** No result is shown for any period in which fewer
   than five employees were active. This threshold shall not be lowered. It
   may be raised, per team, up to ten; the parties agree the value in
   Annex A.
4. **Signals.** The indicators in Annex A are active. Any change requires
   the council's consent and is made through the software's switches.
5. **Access.** The Team health page is visible to the members of the
   project or space it describes and to their manager. Settings may be
   changed only by project administrators (Jira) or space administrators
   (Confluence).
6. **Retention.** Data is retained as set out in §5 of the pack and not
   longer. Neither party may export or copy the data.
7. **Transparency.** Employees are informed before activation with the
   notice in §9. The council receives the pack and may inspect the
   software's source.
8. **Evaluation.** After six months the parties review whether the
   indicators led to changes in working conditions, and whether any risk
   to individuals has arisen. The council may terminate the use of the
   software with one month's notice.
9. **Annex A: active signals.** (List from the settings screen.)

## 9. Notice to employees (one page)

*Our team's Jira and Confluence activity is summarised by Happy Company.
It counts when and how much work happens, so that we can see, as a team,
whether we are working too late, too fragmented, with too much carried over
or under too many moved deadlines. It does not read what you write, it
does not show anything about you as a person, and it shows nothing at all
for weeks in which fewer than five of us were active. Your account id is
replaced by a code that is different in every company and cannot be turned
back into your name. Per-person counts are deleted after 21 days; team
figures are kept for six months. Nothing leaves Atlassian's servers. The
works council has agreed which signals are active; the list is on the Team
health page. Questions: [HR contact].*

## 10. Privacy & Security tab: the answers

| Question | Answer |
|---|---|
| Does the app store End User data? | Yes: pseudonymised activity counts and hours, hashed item ids, per-team aggregates. No content. |
| Where? | Forge hosted storage, in the customer's Atlassian data residency region. |
| Does the app egress data outside Atlassian? | No. No remotes, no external fetch, no analytics. Runs on Atlassian. |
| Sub-processors | Atlassian only. |
| Retention | Per-person counts 21 days; team aggregates 26 weeks; snapshots 91 days; sprint summaries 182 days; deleted on uninstall. |
| Encryption | At rest and in transit by Atlassian's Forge platform. |
| Access by the vendor | None. The vendor cannot read any installation's storage. |
| Certifications | None of the vendor's own yet; the platform's are Atlassian's. |
| DPA | Not required from the vendor: the vendor does not process the data. The customer's Atlassian DPA covers the platform. |
| Security contact | [security e-mail on the listing] |
