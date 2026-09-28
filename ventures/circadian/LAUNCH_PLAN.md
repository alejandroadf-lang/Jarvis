# Circadian: 30-day launch plan

Written 2026-09-28, revised the same day to add the API and WHOOP tracks.
Circadian is the one venture in focus until this plan ends.

**The question it answers:** who will pay for Circadian: travellers, other
companies through the API, or WHOOP? The three are tested side by side for
30 days, and the numbers decide which one gets the next 60.

**The rule for these 30 days:** no new features. The exceptions are fixing
what real travellers or developers report, and one small change in week 3 for
the consumer price test.

## Why anyone would switch

The category leader is Timeshifter: $9.99 a trip, $24.99 a year, or $149 for
life. Its money grows through partners: United, the Lufthansa Group, oneworld,
IHG and the travel agency FCM. Its reviews complain about the same thing again
and again. The plan assumes a free agent and does not recover when the trip
changes:

- light at times the traveller has meetings
- no way to follow it through a delay
- flight edits allowed only up to 3 hours after departure

(Sources: the research report in `reports/Circadian jet lag app experience.md`.)

Circadian answers those complaints:

- it takes real flight times from the flight number
- it re-plans each morning from last night's actual WHOOP sleep
- it has "done / couldn't" on each moment and a morning check-in
- it needs no app store and no account

**The one-line pitch:** *a jet lag plan that adapts when your trip doesn't go
to plan, using your WHOOP.*

## What the readiness test showed (2026-09-28)

| Checked | Result |
|---|---|
| 19 real routes, 3 sleep types, 57 plans | No crashes. No light advice on the wrong side of the body clock. About 3 ms a plan. |
| Developer API | Keys, limits and errors work. About 35 ms a request under 8 callers at once. |
| A new traveller on an iPhone-sized screen | Plan, Today card, calendar export: no errors, nothing too small to tap. Opens in 0.6 s. |
| WHOOP connected, mid-trip | Baseline, nights against the plan, today's times moved, adaptation verdict: all work. |

Fixed during the test:
- Editing the example trip's outbound past its return date failed on the
  first try. The return now moves with the outbound.
- The error message named the wrong flight. It now names both.
- The developer API is now sellable: a public page, a free key, plans and
  monthly quotas, and one error format.

Still to check by hand: the date fields on a real iPhone. On a narrow screen in
a desktop browser the time is cut off.

## Before day 1 (one evening)

1. **Submit WHOOP app approval today.** Until WHOOP approves Circadian, at most
   10 WHOOP members can connect it, and WHOOP reviews once a month. The
   request text is ready in `WHOOP_PITCH.md`. It needs the privacy page URL
   and a contact email.
2. **Redeploy** the Jarvis service on Railway.
3. In Railway, set:
   - `POSTHOG_API_KEY`: without it, nothing below can be measured
   - `CIRCADIAN_CONTACT_EMAIL`: named on the privacy and developer pages
   - `CIRCADIAN_ADMIN_TOKEN`: 24 or more random characters, to manage API keys
   - `CIRCADIAN_API_CHECKOUT_URL`: a Stripe payment link for Starter at $29 a
     month, made in the Stripe dashboard
   - `AERODATABOX_API_KEY`: flight lookup; the free tier is enough
   - `XAI_API_KEY`: X search, used to find travellers and developers
4. On your phone:
   - make a real plan for your next trip
   - add Circadian to the home screen
   - turn reminders on and connect WHOOP
   - screenshot the Today screen, which is the image for every post
   - open `/circadian/developers` and get yourself a free key, to see what a
     company sees

## Track A: travellers

**Week 1: the first 30 real trips.** Post your own trip, the screenshot and the
link. Never an ad. Ask for feedback, not signups.

| Channel | What to post |
|---|---|
| r/whoop | "I built a jet lag plan that reads my WHOOP sleep and re-plans each morning. Tried it on [route]." |
| FlyerTalk, the travel technology forum | The same, framed around delays: "it re-plans when the flight moves". |
| r/travel, r/digitalnomad | Shorter, with the Today screenshot. |
| X | Reply to people posting about jet lag this week. Ask the Market Researcher: "find people on X complaining about jet lag or Timeshifter in the last 7 days". |
| Friends and colleagues who fly | Personal messages, the most reliable first ten. |

Until WHOOP approves the app, say in posts that WHOOP connection is limited
while in review. The plan works without it.

Do not use the company's customer email tool for travellers. Cold email to
consumers is the wrong channel, and it is the one with legal exposure.

**Every day, 20 minutes:** answer every comment, and write down every complaint
word for word.

**Week 2:** fix the top three complaints and nothing else. Talk to five
travellers who finished a trip, for 15 minutes each:
- What did you do the first morning you landed?
- Which moment could you not follow, and why?
- What did you use before this?
- Would you use it for your next trip?

Then post a short "what I changed from your feedback" follow-up.

**Week 3: the price.** After a traveller rates their jet lag at the end of a
trip, show one line. Test per trip against per year:
*"Circadian is free while in testing. Founding travellers: $4.99 a trip, or
$19 a year for life."* Each links to a Stripe checkout. Ask the five
interviewees the same.

## Track B: companies, through the API

The API is live at `/circadian/v2/plan`. The page companies see is
`/circadian/developers`:
- what it handles
- a quickstart they can paste
- the plans: Free (100 plans a month), Starter ($29 a month for 5,000) and
  Scale (by arrangement)
- a form that gives a free key on the spot

**Week 1: a list of 20.** Ask the Market Researcher to find 20 companies whose
product touches people who fly. Aim for small ones that answer email, in these
categories:
- trip-planning and itinerary apps
- corporate travel tools and travel management companies
- corporate wellness and sleep-coaching apps
- wearable companion apps
- sports team performance software

Write down, for each, why jet lag matters to their users.

**Week 2: ten conversations.** Write to 10 of them, founder to founder, with
the developer page link and one sentence on what their users get.
- LinkedIn or a personal email from you works best.
- The company's outreach tool is allowed for this, because it's business to
  business. It adds the legal footer and refuses German and Italian addresses.

**Week 3: trials.** Anyone who replies gets a free key and 15 minutes of your
time. Check `/circadian/admin/api-keys` for who is actually calling.

**Week 4: ask for money.** For any company over 50 plans in the month, offer
Starter. When they pay through the payment link, move their key to Starter:

```
curl -X POST https://<your-domain>/circadian/admin/api-keys/<key_id> \
  -H "Authorization: Bearer $CIRCADIAN_ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"plan":"starter"}'
```

## Track C: WHOOP

The full pitch is in `WHOOP_PITCH.md`. In short: WHOOP's April 2026 jet lag
advisor notices the time change after landing. Circadian plans the trip before
it.

- **Before day 1:** submit app approval, as above.
- **Weeks 1 to 4:** collect the proof the pitch needs:
  - 50 trips planned with WHOOP connected
  - 25 rated trips
  - a share of moments followed
  - the median nights to adapt
  - three quotes
- **When approved and the proof exists:** send the partnership email in
  `WHOOP_PITCH.md`. The first ask is small: a link from WHOOP's advisor, or a
  mention where WHOOP lists integrations.

## Week 4: measure and decide

| Track | Measure | Where | Target by day 30 |
|---|---|---|---|
| Travellers | Planned a real trip | PostHog `plan_made`, the button | 100 |
| Travellers | Used it during the trip | `moment_logged` or `morning_feel` | 20 |
| Travellers | Rated their jet lag after | `jet_lag_rated` | 10 |
| Travellers | Paid for the founding offer | Stripe | 5 |
| Companies | Conversations | Your notes | 10 |
| Companies | Keys making real calls | Admin list, `used_this_month` | 3 |
| Companies | Paying for Starter | Stripe | 1 |
| WHOOP | App approved | Developer Dashboard | Yes |
| WHOOP | Trips with WHOOP connected | `whoop_connected` | 15 while the 10-member limit lasts, 50 after approval |

**The decision on day 30:**

- **One paying company, or three making real calls:** the API is the business.
  Spend the next 60 days on Track B. Make key upgrades automatic from Stripe
  at the tenth customer, not before.
- **Five paying travellers, or 20 using it during the trip:** the consumer app
  earns its keep. Put the price in the product properly.
- **WHOOP approved, with the proof:** send the partnership email whatever the
  other tracks say. One partner is worth more than either of the others.
- **Plenty of plans, few used during the trip:** try pilots and cabin crew, or
  business travel managers, who have the problem every week.
- **None of the above:** keep Circadian running for your own trips and move
  the company's time to the next venture.

## The monthly bill during the test

| Item | Expected |
|---|---|
| Railway, which hosts Jarvis and Circadian | Your current plan |
| AI calls | At most $5 a day, which is the spend cap; less in MODE ECO |
| Flight lookups | $0, with a free-tier ceiling of 20 a day |
| PostHog | $0 on the free tier at this volume |
| X search | A few cents per research question |
| API plans served | A few milliseconds of server time each, which is nothing on the bill |
| Stripe | Its standard card fee, roughly 3% plus a small fixed fee, and only when someone pays |

Nothing new is subscribed to during the 30 days.
