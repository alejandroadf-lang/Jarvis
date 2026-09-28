# Pitching Circadian to WHOOP

Written 2026-09-28. The goal is for Circadian to add a capability WHOOP does
not have, not to compete with what it has.

## What WHOOP already has

WHOOP shipped a jet lag advisor in April 2026. It reacts when a member lands:

- a "Time Change Detected" prompt that names the shift and warns that sleep
  timing, recovery and HRV may be affected
- a push notification on arrival that opens a chat with WHOOP's AI about
  sleep timing, light, hydration and caffeine

WHOOP's own figure is that **35% of members change time zones each month**.
Its researchers have also published on travel, recovery and performance, and
on keeping teams on home time. Jet lag matters to WHOOP. It chose to meet it
with alerts and conversation after landing.

## What Circadian adds

Everything below works today, on WHOOP's API v2 and its webhooks.

| | WHOOP's advisor | Circadian |
|---|---|---|
| Starts | On landing | Up to 3 days before departure, shifting sleep at home |
| Knows the trip | The new time zone | The flights: connections, return, multi-city, from the flight number |
| Tells the member | In a chat, when asked | Timed moments (light, dark, last coffee, melatonin, bed) with reminders on the phone |
| After a bad night | General advice | Re-plans today from last night's actual WHOOP sleep |
| Says when it's over | No | Measures adaptation night by night against the prediction |
| Learns what works | No | "Done / couldn't" on each moment and a jet lag rating after the trip |

In one line: **WHOOP notices the time change; Circadian plans the trip.**

## Why WHOOP would want it

- **Members' numbers.** Jet lag shows up as low recovery and HRV for days.
  A plan that starts before the flight shortens that dip, and the dip is in
  WHOOP's own scores.
- **Engagement at the moment it drops.** Travel breaks routines. A plan with
  timed moments gives members a reason to open WHOOP every day of the trip.
- **Research.** Adherence taps plus WHOOP sleep give a measured outcome per
  trip, which is the data WHOOP's travel research needs.
- **No build cost.** It exists, runs on WHOOP's public API, and can start as
  a listed integration.

## Four ways to work together, smallest first

1. **Approved integration.** This is required anyway: an unapproved app
   serves at most 10 WHOOP members. The ask is approval, then a mention where
   WHOOP lists integrations or in a travel article.
2. **A link from the advisor.** When WHOOP detects a long-haul change, or a
   member mentions a trip in the chat, it offers "plan this trip" and opens
   Circadian. It's a small change for WHOOP, and it gives Circadian
   distribution.
3. **Licence the planning engine.** WHOOP sends the flights and gets back a
   day-by-day plan to show inside its own app (`/v2/plan`, tens of
   milliseconds a plan). Priced per plan, or as a yearly licence.
4. **A joint study.** Members opt in. Compare how fast sleep timing reaches
   local time with a plan and without one. It's publishable, and it proves
   the licence.

Lead with 1 and 2, mention 3, and let WHOOP bring up 4 if its research team
is in the room.

## Proof to bring

The pitch is much stronger with numbers from real WHOOP members. Send it
after the launch plan has produced them.

| Proof | Where it comes from | Target before pitching |
|---|---|---|
| Trips planned with WHOOP connected | PostHog `whoop_connected` and `plan_made` | 50 |
| Trips rated after | `jet_lag_rated` | 25 |
| Moments followed | `moment_logged` done against couldn't | A share, whatever it is |
| Nights to adapt, against the plan's prediction | The adaptation verdict | A median |
| Three quotes from members | The week 2 interviews | 3 |

Until those exist, the approval request (option 1) is the right and only step.

## Risks, and the answer to each

- **"We'll build it ourselves."** They chose chat after landing. A planning
  engine that handles itineraries is a different product. A licence is
  cheaper than building it, and Circadian can say so.
- **Health claims.** Circadian gives general guidance, never medical advice.
  Every plan says so, and melatonin carries a "talk to a doctor" line. Keep
  it that way in every document sent.
- **Privacy.** Circadian asks only for sleep and recovery (read-only) and
  sells nothing. Disconnecting WHOOP deletes the tokens, and turning
  reminders off deletes the stored trip. The privacy page says this and is
  the URL WHOOP asks for.
- **Brand.** Follow WHOOP's design and brand guidelines in the app and in the
  approval request. Do not use WHOOP's logo or "WHOOP" in Circadian's name.

## Who to contact, in order

1. **The Developer Dashboard.** Open a request and choose *App approval*.
   Include:
   - the app name
   - contact email
   - privacy policy URL (`/circadian/privacy`)
   - screenshots of the Today screen with WHOOP connected
   - a paragraph on what the app does with the data

   WHOOP reviews monthly, so submit now.
2. **WHOOP's partnerships or developer relations team.** Once approved,
   through the same dashboard thread or a warm introduction on LinkedIn.
3. **WHOOP's performance science team,** for the study. They authored the
   travel research.

## The approval request (draft)

> **Circadian: jet lag plans from real flights, re-planned from WHOOP sleep**
>
> Circadian plans sleep, light, caffeine and melatonin around a member's
> actual flights, starting up to three days before departure. With WHOOP
> connected, it reads the last two weeks of sleep to set the member's usual
> times. Each morning it compares last night's sleep with the plan and moves
> today's times to match. After the trip it shows how many nights the body
> took to adapt against what the plan predicted.
>
> Scopes: read:sleep, read:recovery and offline. The WHOOP user id is kept
> from the sleep records, to match the "night scored" webhook to the member.
> Nothing is sold or shared. Disconnecting deletes the tokens. Privacy
> policy: [URL]/circadian/privacy.
>
> It complements WHOOP's jet lag advisor: the advisor notices the time
> change, and Circadian plans the trip around it.

## The partnership email (draft, after approval and the first numbers)

> Subject: A pre-flight plan for the 35% of members who change time zones each month
>
> Hi [name],
>
> WHOOP's jet lag advisor tells members when a time change hits. Circadian,
> an approved WHOOP integration, plans the trip before it does. It starts up
> to three days out from the member's real flights, sends timed light,
> caffeine and sleep moments, and re-plans each morning from their WHOOP
> sleep.
>
> In the last [30] days, [N] members planned trips with it. They followed
> [X]% of the moments, and adapted in a median of [D] nights against [P]
> predicted.
>
> Two small things would help members find it: a link from the advisor when
> it sees a long-haul change, or a mention where WHOOP lists integrations.
> If it proves out, the planning engine is available to run inside WHOOP too.
>
> 15 minutes to show you?
>
> [name]

Sources:
- [WHOOP adds a jet lag advisor, Gadgets & Wearables, April 2026](https://gadgetsandwearables.com/2026/04/06/whoop-jet-lag-advisor/)
- [2026 What's New at WHOOP](https://www.whoop.com/us/en/thelocker/2026-whats-new/)
- [WHOOP travel, recovery and performance research](https://www.whoop.com/us/en/press-center/whoop-researchers-contribute-to-new-peer-reviewed-review-on-travel-recovery-and-performance/)
- [Time zone maintenance in team travel, WHOOP](https://www.whoop.com/us/en/thelocker/time-zone-maintenance-an-approach-to-mitigate-the-effects-of-jet-lag/)
- [WHOOP app approval](https://developer.whoop.com/docs/developing/app-approval/)
- [WHOOP Developer Platform](https://developer.whoop.com/docs/introduction/)
