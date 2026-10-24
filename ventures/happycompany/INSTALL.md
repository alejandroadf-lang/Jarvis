# Deploy and install Happy Company in one workspace

Goal: the app deployed to Forge and installed in one real Jira and one real
Confluence site, with the install verified. Only you can do the Atlassian
parts (account, token, site). Everything else is already in the repo.

Nothing here changes what the app collects, how long it keeps it, who can see
it, or any group-size floor. Those promises are in `WORKS_COUNCIL.md`.

## What you need (once, about 15 minutes)

1. An Atlassian account and a free developer site for Jira and one for
   Confluence: https://go.atlassian.com/cloud-dev. A site you already own works
   too; use the **development** environment on it, never production.
2. The app's id. Developer console -> https://developer.atlassian.com/console/myapps
   -> Create -> Forge app. Copy the App ID (`ari:cloud:ecosystem::app/...`).
   Or run `forge register` once on a laptop, which prints the same id.
3. An API token from https://id.atlassian.com/manage-profile/security/api-tokens.
   It goes into GitHub secrets or `forge login` and nowhere else: not a chat,
   not a commit.

The manifest holds a placeholder id on purpose, so nobody else can deploy this
app under the wrong id.

## Path A: from GitHub, no laptop (recommended)

1. Repo -> Settings -> Secrets and variables -> Actions:
   - secret `FORGE_EMAIL`: the Atlassian account e-mail
   - secret `FORGE_API_TOKEN`: the token from step 3
   - variable `FORGE_APP_ID`: the App ID from step 2
2. Actions -> "Happy Company deploy" -> Run workflow:
   - environment: `development` (or `staging`)
   - install_site: `yourname.atlassian.net` (no https://)
3. The run tests, lints, deploys, then installs in Jira and in Confluence on
   that site. Green means deployed and installed. A red run names what is
   missing (for example a secret not set).

The workflow installs with `--confirm-scopes`, which skips the scope prompt.
Read the scopes in `manifest.yml` once before you run it; each one has a
reason written beside it.

## Path B: from a laptop

```
npm install -g @forge/cli
forge login
cd ventures/happycompany
npm install
forge register            # put the printed id into manifest.yml (app.id); do not commit it
forge lint
forge deploy -e development
forge install -e development --site yourname.atlassian.net --product jira
forge install -e development --site yourname.atlassian.net --product confluence
```

The `forge install` flags (`--site`, `--product`, `-e`, `--upgrade`,
`--confirm-scopes`) were checked against the Forge CLI reference at
developer.atlassian.com. After a later deploy that adds scopes, run the same
install command with `--upgrade`.

## Verify the install (this is the objective's evidence)

Do these on the site you installed to, then send the founder the result.

1. **Jira:** open any project -> "Team health" in the project sidebar. The page
   loads without an error banner.
2. **Confluence:** open any space -> "Team health". Same.
3. **Expected on a quiet site:** the page says there are too few people to
   show a grade. That is the 5-person floor working, not a fault. Do not lower
   it to make the page look fuller.
4. **Events arrive:** edit a Jira issue and comment on it, edit a Confluence
   page, then run
   `forge logs -e development --since 30m`. You should see the handler run
   with no stack trace. (The shape log is off by default; see README step 5 if
   you want the event structure as well.)
5. **Daily job:** after the first scheduled run, or after temporarily setting
   the trigger interval to `fiveMinute` on development only, `forge logs`
   should show a line starting `[happycompany] rollup` with an empty `errors`
   list. An error on the `sprints` step means the Jira Software API wants a
   scope the manifest lacks; report it, do not add a scope without review.
6. **Admin view:** Jira -> Apps -> "Working conditions across teams" opens for a
   site admin; Confluence -> global settings -> "Working conditions across
   spaces". A non-admin must be refused.

When 1, 2, 4 and 5 pass, the install is verified for the objective: record
the site name, the date, and the `forge logs` output (it holds no personal
data; the app stores none in logs).

## Not in scope here

- Production releases. Production is other companies' Jira: only ever a manual
  run that chooses it, with a required reviewer on the `forge-production`
  GitHub environment.
- Marketplace licensing (`licensing:` in `manifest.yml`). Turn it on only before
  the paid listing; with it on, the app refuses to run on unlicensed sites,
  including your own.
