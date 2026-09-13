---
name: handling-regulated-claims
description: Shipping a product that touches health, money or legal advice without making a claim the company cannot stand behind — what you may say, what turns a feature into a regulated device, and where the disclaimer has to live.
agents: [cto, engineering_lead, product_manager, solutions_architect, cmo, marketing_manager, brand_strategist, sales_commercial_manager, ceo, security_reviewer, devils_advocate]
---

# Making claims in a regulated space

Some of what this company builds sits next to regulated advice. A circadian
scheduling API is adjacent to sleep medicine. A burnout score is adjacent to
mental health. Anything computing a number from a person's body is one
sentence away from being a medical claim, and the sentence is usually written
by marketing rather than engineering.

The rule is not "avoid the topic." It is that the product describes **what it
computed**, never **what the person should do about their health**. That one
distinction does most of the work, in the code and in the copy.

## The line, concretely

Safe — describes a calculation, its inputs, and a general published finding:

- "Based on the local times you gave, your estimated circadian low is 03:40."
- "Light exposure in this window is associated with a phase advance in
  published studies."
- "This schedule shifts your sleep window by 40 minutes per day."

Not safe — diagnoses, treats, prescribes, or promises an outcome:

- "You have delayed sleep phase disorder."
- "Take melatonin at 21:00." Any dose of anything, ever.
- "This will cure your jet lag." Also "eliminates", "fixes", "treats",
  "prevents".
- "Safe for pregnant travellers." A safety claim is a claim.
- "Clinically proven" — unless you are holding the trial, and you are not.

The verbs are the tell. *Diagnose, treat, cure, prevent, mitigate* are the
words that move a product from wellness into medical-device territory in both
the US and EU frameworks. *Estimate, compute, suggest, is associated with* do
not.

## Where the disclaimer lives

In the API response payload, as a field. Not only in the docs, not only in the
landing page footer, not only in the onboarding email.

The reason is mechanical: your customer is a developer whose app renders your
JSON. Whatever is not in the JSON does not reach the person the claim is about.
A disclaimer on your own marketing site protects your site and nothing else.

So: a `disclaimer` field on every response that carries a health-adjacent
number, and a line in the contract saying it must be displayed. And then the
thing that actually matters — **a test asserting the field survives
serialisation**, because a disclaimer that exists in the model and is dropped
by a response filter or a `response_model` that omits it is worse than no
disclaimer at all. It looks handled in code review and is absent in
production. Test the rendered HTTP response, not the object.

## Personal data, because it always comes with this

A body metric is health data, which is a special category under GDPR and
named data under HIPAA if you are handling it for a covered entity. Three
defaults that keep this from becoming a project of its own:

**Compute, do not keep.** If the API takes times in and gives a schedule out,
store nothing. "We do not retain your data" is both the strongest privacy
position available and the cheapest to implement, and it is only available
before someone adds an analytics table.

**Never in a log.** The same discipline as an API key: log the request id, not
the body. An exception handler that dumps the request is the leak.

**If you must store it, say exactly what and for how long,** and be able to
delete it on request. A retention period you cannot enforce is a promise you
are already breaking.

## Before anything goes out

For code:

- no prescriptive verb in any user-facing string — grep for *should*, *take*,
  *cure*, *treat*, *prevent*, *diagnose*, *safe*
- the disclaimer is in the serialised response, proven by a test
- no body data in logs, including the error paths
- the docs state what is not retained

For copy — a landing page, a cold email, a pricing page:

- every claim is either about the computation or cites something published
- no outcome promise, no "proven", no named condition the product treats
- the population you exclude is named, rather than implied by silence

## When you are not sure

Two moves, in this order. Rewrite the claim as a description of the
calculation and see whether it still sells the product — usually it does, and
the problem dissolves. If it does not, the feature may genuinely need a
claim you cannot make, and that is a decision for the founder with the risk
stated plainly, not a line to soften until it passes.

What is never acceptable is shipping the strong version because the weak one
converts worse. The company's standing rule is that nothing goes out that
leaves someone worse off than before it reached them, and a confident health
claim from a system that has tested nothing is exactly that.

Consult the Devil's Advocate on any claim you are about to put in front of a
real person. Its first question — which assumption is being treated as a fact
— is the same question a regulator asks.
