# Happy Company: the pilot kit

Three pilot teams calibrate the thresholds and produce the testimonials and
screenshots the listing needs. This is everything the founder sends and runs.

## Who to invite

- A team of 8 to 40 people that lives in Jira, ideally also Confluence.
- Busy in a way you can name: a release train, a quarter end, an on-call
  rotation, a client deadline.
- One pilot in Europe with a works council, so the works-council pack meets
  a real one before the listing.
- A manager who will look at the page once a week and talk for 30 minutes a
  month. That is the whole cost to them.

Good places to look: your travel-tech network (agencies, OTAs, airline and
hotel IT teams run on Jira), engineering leads you have worked with, and the
Atlassian Community groups for your city.

## The invitation (edit the brackets)

> Subject: A free look at your team's workload, without surveys
>
> Hi [name],
>
> I am building a small app for Jira and Confluence that shows a team, as a
> team, when it is running too hot: late nights, weekends, long days, work
> piling on one person, sprints that never finish, deadlines that keep
> moving. It reads when and how much work happens, never what anyone
> writes, and it shows nothing for groups under five people. Nothing leaves
> your Atlassian site.
>
> I am looking for three teams to use it free for six months while I tune
> it. In return: a 30-minute call once a month on whether what it flags
> matches what the team feels, and permission to quote you anonymously.
>
> Setup is five minutes for a Jira admin. If it is useful, I would love
> [team] to be one of the three. Could we talk for 15 minutes this week?
>
> [your name]

## What the pilot agrees to (one paragraph, for their manager or legal)

> [Company] installs Happy Company on its Atlassian Cloud site for six
> months at no cost. The app runs on Atlassian's infrastructure, stores only
> pseudonymised activity counts and team aggregates (see the works-council
> pack), and sends no data outside Atlassian. [Company] may uninstall at any
> time, which deletes all app data. The vendor may describe [Company]'s
> results in anonymised form; naming [Company] requires its written consent.
> The vendor has no access to [Company]'s site or data.

## Kickoff checklist (week 0)

1. The Jira admin installs from the private listing link (and in Confluence,
   if they use it).
2. A project admin opens Team health, sets the team time zone, quiet hours,
   weekend days and public holidays.
3. If there is a works council: send `WORKS_COUNCIL.md` first, and switch off
   any signals it has not agreed to before anyone looks at a figure.
4. Tell the team, with the notice in `WORKS_COUNCIL.md` §9.
5. Jira: if the works agreement allows it (clause 10), a project admin presses
   "Fill in history" in Settings, and the first card appears the next
   morning instead of after a week.
6. For the validation study (`VALIDATION.md`): the monthly pulse on, with
   validation mode, in at least eight teams across the pilots.
7. First useful page after about a week (or the next morning with history);
   the trend after four.

## The monthly call (30 minutes, the same five questions)

1. Look at the last four weeks together. Which week felt worst to the team?
   Is it the week the page scores lowest?
2. Of the "three things to change" it showed, which did you act on? What
   happened?
3. Which signal was wrong or unfair for your team, and why?
4. Is anything missing that the team would have wanted flagged?
5. Would you pay [price] a month for this for your whole site? If not, what
   would make it worth it?

Write the answers into `pilots/[company]-[month].md` (not committed if they
contain names). Question 1 is the calibration: a band in `src/lib/score.mjs`
moves when two pilots say a flagged week was fine or a bad week went
unflagged.

## What "the pilot worked" means (day 90)

- At least two of three managers open the page most weeks without a reminder.
- At least one "three things" action was taken and the next weeks improved.
- At least one pilot would pay, or names what would make it pay.

Below that bar, PLAN.md's day-90 rules apply.
