---
name: writing-docs-someone-can-follow
description: How to write setup instructions, READMEs and runbooks that work for someone who is not you — what to put first, what to leave out, and the test that catches most broken docs.
agents: [cto, engineering_lead, product_manager, solutions_architect, customer_support_manager, qa_engineer]
---

# Writing docs someone can follow

A document that is accurate and unusable has failed. The reader is not
checking your work; they are trying to get something done, and every sentence
that does not move them forward is a sentence they have to read anyway.

Assume the reader is impatient, unfamiliar, and on a phone. That last one is
not hypothetical here — this company's founder often is, which means no
terminal, no copy-pasting a long block into a shell, and no scrolling through
three screens of preamble to find the one value they need to paste into a
settings panel.

## Put the outcome first

The first two lines say what this gets you and roughly what it costs:

> **Connecting the mailbox.** After this the team can read replies to customer
> emails. Needs an app password from your mail provider; about five minutes.

Not the architecture, not the rationale, not a history of the feature. Someone
who wants those will keep reading; someone who wants the five minutes can
start now.

## Write steps that can actually be done

A step is one action with one visible result. The bar is that someone could
do it while distracted and know whether it worked.

Good:

> 3. In Railway, open **Variables** and add `IMAP_HOST` with the value
>    `imap.gmail.com`. The service redeploys automatically — it is done when
>    the deployment goes green.

Bad:

> 3. Configure the IMAP settings appropriately.

The difference is that the first one names where, names the exact value, and
says how to tell it worked. Every step needs that third part. A step with no
observable result is a step people silently skip.

Number steps that must happen in order. Bullet things that don't. Getting that
backwards is why people do step four before step two.

## Say where each value comes from

Most setup instructions break at exactly one point: a value the reader does
not have and the doc does not say how to get. For every credential or
identifier, say where it is obtained, with a link:

> `IMAP_PASS` — an app password, not your normal password. Generate one at
> https://myaccount.google.com/apppasswords.

And say plainly where it goes. In this project, secrets go into the Railway
environment and never into chat, a file, or a commit — which is worth writing
down every time, because the moment a doc is ambiguous about that, someone
resolves the ambiguity the easy way.

## Say what it looks like when it worked

End with the check, not with the last step. "It is working when the
integration panel shows inbound email as configured" saves the reader from
the worst state a doc can leave them in: finished, uncertain, and with nothing
to test.

Include the two or three ways it usually fails and what each one means.
Troubleshooting is not an appendix; for most readers it is the part they
actually use.

## What to leave out

- Why it was built this way. That belongs in the code or in `ORG_STRUCTURE.md`,
  not between step three and step four.
- Anything that is true but does not change what the reader does.
- Reassurance. "Don't worry, this is easy" is what a doc says instead of being
  easy.
- Every option, when one default works. Name the default, mention that others
  exist, move on.

## The test

Reread it as someone who has never seen this system, and find the first point
where you would have to ask a question. That point is the bug. Fix it and read
again.

If you cannot manage that — and it is genuinely hard on something you just
built — use the cheaper proxy: **every step must name a thing you can see.** A
button, a panel, a file, a specific line of output. Any step that names only
an intention is the step that will break.
