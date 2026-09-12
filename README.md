# Jarvis

A personal voice assistant. React chat UI (with browser speech-to-text and
text-to-speech) talking to an Express backend that calls the Claude API.

It also ships two more modes built the same way — a hierarchy of Claude
agents that delegate to each other via tool use:

- **Executive Team**: a virtual IT-company org chart (CEO, CTO, CFO, CMO,
  COO, and their department leads) that answers requests by routing them to
  the right department.
- **Venture Studio**: a brainstorming team (Venture Partner, Market
  Researcher, Ideation Facilitator, Business Case Analyst, Scale
  Strategist, Validation Critic) that helps find and pressure-test the
  next idea, then starts it as a real venture and hands it to the
  Executive Team to build.

**It runs on no capital.** That's the deliberate design: the biggest cost
in a normal business is people, and this company's people are agents, so
there's no seed, no budget ceiling, and no funding approval standing
between an idea and starting it. What's tracked instead is only the money
that's genuinely real — revenue actually earned and expenses actually paid
— plus the constraints that actually bind: the founder's attention, a hard
daily model-spend cap, and per-venture scopes for anything that reaches the
outside world. See
[the economic model](./ORG_STRUCTURE.md#the-economic-model-no-capital-required)
for why the earlier $100-seed version was making the company worse.

A **Portfolio** tab rounds it out: every venture ever created (active or
killed) with its own slice of the ledger and milestone progress, so you
can compare the whole company at a glance instead of one venture at a
time.

The management team also runs itself day to day: once every 24 hours, at
8:00 AM Bangkok time (no one needs to start the conversation), the
Executive Team holds a leadership sync — the CEO checks in with the
C-suite, who check in with their own teams — and the Venture Studio
reviews whatever opportunities came out of it for a possible new
venture. The result is saved as a **Daily Report** you can read at any
time, or trigger on demand with a "run now" button, and — if you set
`SMTP_HOST`/`REPORT_EMAIL_TO` in `server/.env` — emailed to you as soon
as it's ready. It can start a venture on its own (that costs nothing and
grants it nothing), and it can deploy code or email a customer for a
venture you've already granted that specific scope to — but it can never
touch the books or kill a venture, since those depend on you reporting a
real outcome.

See [ORG_STRUCTURE.md](./ORG_STRUCTURE.md) for the full architecture,
roster, and how an idea becomes execution.

## Stack

- **Client:** React + Vite 5 + Tailwind CSS v4, Web Speech API for voice in/out
- **Server:** Express (ES modules), `@anthropic-ai/sdk`

## Development

```bash
npm run install:all

# terminal 1
npm run dev:server    # localhost:3001

# terminal 2
npm run dev:client    # localhost:5173, proxies /api to :3001
```

Copy `server/.env.example` to `server/.env` and set `ANTHROPIC_API_KEY`.

## Tests

```bash
npm test    # runs the server's unit tests (server/test/, Node's built-in test runner)
npm run lint  # lints the client
```

The server tests cover the pure data-layer logic — the ledger, ventures
(including milestones, real-action scopes, and kill), and session
persistence — by
pointing `server/store.js` at a throwaway temp directory (`JARVIS_DATA_DIR`)
instead of the real `server/data/`. They don't touch the Claude API. A
GitHub Actions workflow (`.github/workflows/ci.yml`) runs both on every push
and pull request against `main`.

## Production

```bash
npm run build   # builds client into client/dist
npm start       # starts the server, which serves the built client + API
```

Voice input/output relies on the browser's Web Speech API (Chrome/Edge have
the best support; Safari and Firefox support varies). Conversation history
for all three chat modes is persisted to `server/data/sessions.json` (see
`server/sessionStore.js`) — still no real database, but it survives a
server restart instead of vanishing.

## Deploy to Railway

The daily meeting cycle (see above) only fires if the server is actually
running at 8 AM Bangkok time — on a laptop that's usually off, it won't
be. [Railway](https://railway.app) is a simple way to keep it running
24/7:

1. **Create a new project from this GitHub repo.** Railway detects the
   `Dockerfile` at the repo root automatically (`railway.json` pins the
   builder explicitly, so it won't try to guess otherwise) — no other
   config needed to get it building.
2. **Add a Volume**, mounted at `/data`. The app stores everything it
   shouldn't lose — the ledger, ventures, session history, daily
   reports — as JSON files (see `server/store.js`) under whatever
   `JARVIS_DATA_DIR` points at. Without a volume, that state lives in the
   container's writable layer and is wiped on every redeploy; with one,
   it survives.

   **Check that it worked**, because this fails silently and is otherwise
   only discovered by noticing something has gone missing. The
   Integrations panel has a **Storage** line: after your *second* deploy
   it should say data has survived a restart. If it still says "first
   boot", the volume isn't mounted where `JARVIS_DATA_DIR` points and the
   company is losing its memory every time you deploy.
3. **Set environment variables** on the service:
   - `ANTHROPIC_API_KEY` — required for any of this to work at all.
   - `JARVIS_DATA_DIR=/data` — points persistence at the volume from
     step 2.
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
     `REPORT_EMAIL_TO` — optional, to get the Daily Report emailed (see
     `server/.env.example` for details; Gmail needs an app password, not
     your normal one).
   - `DAILY_MEETING_DISABLED=true` — optional, if you want the app
     running without the autonomous daily cycle.

   Railway injects its own `PORT`, which `server/index.js` already reads
   (`process.env.PORT`), so nothing needs setting there.
4. **Deploy.** `railway.json`'s healthcheck (`GET /api/health`) tells
   Railway to restart the service if it ever stops responding, so the
   scheduler in `server/scheduler.js` gets to actually run every day
   instead of depending on someone remembering to keep a laptop open.

A push to `main` doesn't auto-redeploy unless you connect Railway's
GitHub integration for this repo (its own setting, separate from
anything above) — without it, redeploy manually from the Railway
dashboard after a merge.

### Voice experience

Jarvis mode streams Claude's reply as it's generated and speaks it
sentence-by-sentence as each one completes, instead of waiting for the full
response — noticeably lower latency than speaking the whole reply at once.
`useSpeechSynthesis` also picks the best available system voice (preferring
calm English voices like Daniel/Google UK English Male/Microsoft Guy over
whatever the browser defaults to) and tunes pitch/rate slightly for a more
assistant-like delivery.

There's also a **"Hey Jarvis" wake word** (toggle in the header, Jarvis mode
only): say "Hey Jarvis" followed by your request — in one breath or as two
separate turns — and it's submitted automatically, no click required. It
runs a separate continuous `SpeechRecognition` session from the manual
push-to-talk button, so the two are mutually exclusive while wake word is on.
