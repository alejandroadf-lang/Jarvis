---
name: pricing-a-product
description: Putting a price on something new — what to charge per unit, why the first price is usually too low, the margin arithmetic for an API whose cost per call is real, and how to raise it later.
agents: [cfo, finance_manager, cmo, ceo, product_manager, sales_commercial_manager, business_case_analyst, scale_strategist, venture_partner]
---

# Pricing a product

Price is the fastest lever the company has and the one most often left at its
default, which is "too low, chosen quickly, never revisited." Nothing else
moves revenue as far for as little work — a 30% increase on a product with ten
customers is the same money as three months of outreach, and it takes an
afternoon.

## Price the value, then check it against the cost

Start from what the alternative costs the customer. A developer who would
otherwise spend two days building and maintaining this themselves is
comparing you to two days of their time, not to your compute bill. That
number is the ceiling, and it is usually far above where the first instinct
lands.

Then check the floor. For anything with a per-call cost — a model call, a data
lookup, an egress charge — compute the cost of the worst realistic request,
not the average one, and require a gross margin of at least 70% against it.
The arithmetic that ends a venture quietly: a $29/month plan with unmetered
calls, a customer who makes a hundred times the median, and a cost per call
you were treating as free because it was small.

If value and cost leave no room between them, that is a finding about the
product, not a pricing problem to solve with a spreadsheet.

## Charge for a unit the customer already counts

The best pricing metric is something the customer was measuring before they
met you, that grows as they get more value, and that they can predict.

For an API, requests or some business object — schedules generated, reports
produced, seats. Not CPU seconds, not tokens, not anything that makes the
customer's bill depend on how your implementation happens to work today. If
you optimise the code and their bill drops, you have priced your inefficiency;
if it rises, you have punished them for your change.

Per-seat works when value scales with people. Usage works when it scales with
volume. Flat works when neither, and when you would rather have predictability
than upside.

## Three tiers, and the middle one is the product

A single price gives the customer one decision — yes or no. Three gives them a
choice among your options, and the comparison is what makes the middle one
look reasonable.

- **Entry**, priced so a real evaluation costs almost nothing. Its job is to
  remove the reason not to start, not to make money.
- **Main**, where you expect most customers and where the margin lives. Design
  this one first and build the others around it.
- **Top**, which exists partly to make Main look sensible and partly for the
  customer who needs a guarantee, a limit raised, or an invoice. "Contact us"
  is a legitimate third tier.

Anchor high. The top price changes what the middle one feels like, even for
people who never consider it.

## The first price is a hypothesis, not a commitment

Publish a price. A venture with no price on its page has no way to find out
whether anyone would pay, and "contact us for pricing" on a self-serve API
loses exactly the developer who would have signed up at 2am.

Then read the only three signals that mean anything:

- **Nobody asks the price** → they have not understood the value. A pricing
  change will not fix that.
- **Everyone says yes immediately** → it is too low. A price nobody hesitates
  over is leaving money on the table; a healthy price produces some friction.
- **People ask and then go quiet** → either the price or the value is wrong,
  and the way to find out is to ask the ones who left.

Free trials over free tiers for a small venture: a free tier is a permanent
cost with no path to revenue, while a trial has an end date that forces the
decision.

## Raising it

Honour the old price for existing customers and charge the new one to everyone
after today. Grandfathering is cheap — there are few of them — and it converts
a raise from a betrayal into a reason to have signed up early.

Never apologise for the new price in the announcement. State it, state when it
starts, state what is unchanged.

## Before you commit to a number

- the cost of the worst realistic request, not the average, with the margin
  written down
- the unit is something the customer counts and can predict
- a published number on a page, not "contact us"
- what you will do if the first three prospects all say yes without pausing

And record the reasoning, not just the number. A price whose justification
nobody can reconstruct is a price nobody will ever change.
