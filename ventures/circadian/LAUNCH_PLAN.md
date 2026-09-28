# Circadian: 30-day launch plan

Written 2026-09-28. Circadian is the one venture in focus until this plan ends.

**The question it answers:** will travellers use Circadian for a real trip,
and will some of them pay for it? After 30 days we decide from numbers, not
from how the product feels.

**The rule for these 30 days:** no new features. The exceptions are fixing
what real travellers report, and one small change in week 3 for the price
test.

## Why anyone would switch

The category leader is Timeshifter: $9.99 a trip, $24.99 a year, or $149 for
life. Its reviews complain about the same thing again and again. The plan
assumes a free agent and does not recover when the trip changes:

- light at times the traveller has meetings
- no way to follow it through a delay
- flight edits allowed only up to 3 hours after departure

(Sources: the research report in `reports/Circadian jet lag app experience.md`.)

Circadian already answers those complaints:

- it takes real flight times from the flight number
- it re-plans from last night's actual WHOOP sleep
- it has a "done / couldn't" tap on each moment and a morning check-in
- it needs no app store and no account

**The one-line pitch:** *a jet lag plan that adapts when your trip doesn't go
to plan, using your WHOOP.*

**The first audience:** WHOOP members who fly across five or more time zones.
They already track sleep, they already pay for a wearable, and nobody else
uses their data for jet lag.

## Before day 1 (one evening)

1. **Redeploy** the Jarvis service on Railway.
2. In Railway, set:
   - `POSTHOG_API_KEY`: without it, nothing below can be measured
   - `AERODATABOX_API_KEY`: flight lookup; the free tier is enough
   - `XAI_API_KEY`: X search, used to find travellers
3. Make a real plan for your own next trip on your phone:
   - add it to the home screen
   - turn reminders on and connect WHOOP
   - screenshot the Today screen, which is the image for every post below
4. Set `CIRCADIAN_CONTACT_EMAIL` so the privacy page names an address.
   The page promises that anything kept for a phone is deleted on request.

## Week 1: get the first 30 real trips

Where to post. Each post should be your own trip, the screenshot and the
link, and never an ad. Ask for feedback, not signups.

| Channel | What to post |
|---|---|
| r/whoop | "I built a jet lag plan that reads my WHOOP sleep and re-plans each morning. Tried it on [route]." |
| FlyerTalk, the travel technology forum | The same, framed around delays: "it re-plans when the flight moves". |
| r/travel, r/digitalnomad | Shorter, with the Today screenshot. |
| X | Reply to people posting about jet lag this week. Ask the Market Researcher: "find people on X complaining about jet lag or Timeshifter in the last 7 days". |
| Friends and colleagues who fly | Personal messages, the most reliable first ten. |

Do not use the company's customer email tool for this. Cold email to
consumers is the wrong channel, and it is the one with legal exposure.

**Every day, 20 minutes:** answer every comment, and write down every
complaint word for word in a note. These are the input for week 2.

## Week 2: fix what travellers hit, and talk to five of them

1. Fix the top three complaints from week 1, and nothing else.
2. Talk to five travellers who finished a trip, 15 minutes each. Ask:
   - What did you do the first morning you landed?
   - Which moment could you not follow, and why?
   - What did you use before this?
   - Would you use it for your next trip?
3. Post a short "what I changed from your feedback" follow-up in the same
   places. It is the second post that brings the second wave.

## Week 3: test the price

The product has no paywall, and it should not get one yet. Test willingness
to pay with a pre-sale instead:

- After a traveller rates their jet lag at the end of a trip, show one line:
  *"Circadian is free while it's in testing. Founding travellers can lock in
  $19 a year for life."*
- The line links to a Stripe checkout. This is the small change allowed this
  month. The monthly checkout in Jarvis already shows renewal terms beside
  the pay button.
- That price sits under Timeshifter's $24.99 a year, on purpose. The test is
  whether anyone pays at all, not the best price.
- Also ask the five people from week 2 directly whether they would pay $19 a
  year.

## Week 4: measure and decide

Read the numbers in PostHog. The events are already sent: `plan_made`,
`reminders_on`, `whoop_connected`, `moment_logged`, `morning_feel` and
`jet_lag_rated`.

| Measure | Event | Target by day 30 |
|---|---|---|
| Travellers who planned a real trip | `plan_made` (button, not page open) | 100 |
| Turned reminders on | `reminders_on` | 30 |
| Connected WHOOP | `whoop_connected` | 15 |
| Used it during the trip | `moment_logged` or `morning_feel` | 20 |
| Rated their jet lag after | `jet_lag_rated` | 10 |
| Paid for the founding plan | Stripe | 5 |

**The decision on day 30:**

- **Continue:** 5 or more paid, or 20 or more used it during the trip. Put
  the price in the product properly, and plan the next 60 days around the
  channel that brought the most trips.
- **Change the audience:** plenty of plans but few used it during the trip.
  The product is interesting but not needed by these people. Try pilots and
  cabin crew, or business travel managers, who have the problem every week.
- **Stop:** fewer than 30 real plans after two rounds of posting. Nobody is
  looking for this. Keep it running for your own trips and move the company's
  time to the next venture.

## The monthly bill during the test

| Item | Expected |
|---|---|
| Railway, which hosts Jarvis and Circadian | Your current plan |
| AI calls | At most $5 a day, which is the spend cap; less in MODE ECO |
| Flight lookups | $0, with a free-tier ceiling of 20 a day |
| PostHog | $0 on the free tier at this volume |
| X search | A few cents per research question |
| Stripe | Its standard card fee, roughly 3% plus a small fixed fee, and only when someone pays |

Nothing new is subscribed to during the 30 days.
