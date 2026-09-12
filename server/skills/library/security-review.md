---
name: security-review
description: How to review code or an endpoint for vulnerabilities — the order to work in, what counts as critical, and what a finding must contain to be actionable.
agents: [security_reviewer, engineering_lead, cto]
---

# Reviewing for vulnerabilities

Work the highest-risk surfaces first. Most findings that matter live in a
small number of places.

1. **Authentication and authorization.** Who can call this? What happens with
   no credential, a wrong one, or another user's? An endpoint that mutates
   state and checks nothing is the finding that makes every other guardrail
   conditional.
2. **Anything reaching a database.** String-concatenated SQL is CRITICAL every
   time; the fix is parameterised queries, not escaping.
3. **Secrets.** Hardcoded credentials are CRITICAL. So is a secret that
   reaches a log, an error message, or a client bundle.
4. **User input that becomes something else** — a shell command, a file path,
   a template, HTML.
5. **Anything irreversible**: payments, deletion, outbound email, code that
   ships. Ask what a loop or a retry does here.
6. **Rate limits and caps** on anything that costs money or reaches a person.

## What a finding must contain

A severity alone is not actionable. Every finding needs four things:

- **Where** — file and line, or the exact endpoint.
- **What** — the pattern, named. "Broken access control", not "security issue".
- **Why it matters here** — the concrete consequence in this system, not the
  textbook one. "Anyone with the URL can disable the kill switch" beats
  "missing authentication".
- **The fix** — specific enough to implement without another round trip.

## Severity, honestly

- **CRITICAL** — exploitable now, by anyone, with real consequence. Hardcoded
  secret, SQL injection, missing auth on a mutating endpoint.
- **HIGH** — exploitable with a precondition that is likely to hold.
- **MEDIUM** — real, but needs an unlikely precondition or has limited blast
  radius.
- **LOW** — defence in depth. Say so rather than inflating it.

Inflating severity to get attention costs you the attention next time. If the
worst thing you found is MEDIUM, the report says MEDIUM.

## What not to do

Do not report the absence of a feature as a vulnerability. Do not pad the
list to look thorough — a review with three real findings is more useful than
one with three real findings and nine filler items. If a surface is genuinely
clean, say it is clean.
