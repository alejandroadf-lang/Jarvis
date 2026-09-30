# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open this repository's
**Security** tab and choose **Report a vulnerability**. Do not open a public issue,
and do not include live credentials or personal data in the report.

You should get an acknowledgement within 3 working days. Fixes ship as a normal pull
request once the report is confirmed; the reporter is credited unless they ask not to be.

## What is in scope

- The server (`server/`), the client (`client/`) and the shared packages (`packages/`).
- The ventures that ship from this repo: Circadian (`ventures/circadian`) and
  Happy Company (`ventures/happycompany`).
- Anything that lets an agent act outside its limits: spend past the daily cap, send
  email or merge, deploy or change a price without the founder's approval, or reach
  data it should not.

## How this repo handles secrets

- Secrets live in Railway variables only, never in the repo, a commit message or chat
  (see `CLAUDE.md`). `server/.env.example` lists every variable with its name only.
- The kill switch (`server/killSwitch.js`) and the daily spend cap (`server/spend.js`)
  are the first response to an agent behaving badly: stop first, investigate second.
- A leaked key is rotated at the provider immediately, then removed from Railway and
  replaced; deleting it from history alone is not enough.

## Supported versions

Only `main`, as deployed, is supported.
