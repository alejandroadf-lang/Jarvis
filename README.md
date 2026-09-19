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

It also ships the company's first product, in a **Travel Voice** tab and on
its own WhatsApp number: a voice-to-voice Amadeus and travel-industry advisor
in Spanish, French and English. Send it a voice note asking how to price a
PNR or what a fare rule means, and it answers with a voice note in the same
language. See [Travel Voice Advisor](#travel-voice-advisor) below.

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

## Travel Voice Advisor

The first venture built on this company, and the first thing here that talks
to someone who is not the founder. A travel agent sends a WhatsApp voice
note — "¿cómo valoro este PNR con la tarifa más baja?", "comment annuler un
segment sans perdre le dossier ?", "what does fare basis ONNAZ tell me?" —
and a senior Amadeus advisor answers in a voice note in the same language,
with the words as a text underneath so an entry like `FXP` can be copied.
Code lives in `server/travelVoice/`; the Travel Voice tab in the client is
the same advisor without a phone.

What it needs, in layers:

- `ANTHROPIC_API_KEY` — text answers in the tab and on WhatsApp.
- `OPENAI_API_KEY` — hearing and speaking (Whisper in, Ogg Opus out).
- `TRAVEL_VOICE_PHONE_NUMBER_ID` — its own WhatsApp number from the same
  Meta app as the founder's line. The webhook routes on the number a message
  arrived at: this one goes to the advisor, any other to the company. It is
  open to any caller unless `TRAVEL_VOICE_ALLOWED_NUMBERS` narrows it, with a
  per-caller hourly limit and the daily spend cap behind it.
- `AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET` — live flight offers and
  airport lookups from the Amadeus Self-Service APIs, so "cheapest MAD to CDG
  on the first" gets a real price rather than a description of how to search.

**Ears, brain and voice are each pluggable.** The same voice note can be
heard by OpenAI Whisper, ElevenLabs Scribe or Deepgram Nova; answered by
Claude, IONOS (EU-hosted Llama or Mistral), OpenAI, Gemini, DeepSeek or
OpenRouter; and spoken by OpenAI, ElevenLabs or Deepgram Aura. Three
dropdowns in the Travel Voice tab pick them per turn, and each reply shows
which provider did each stage, how long it took and what it cost, so
comparing them is a matter of asking the same question twice. What WhatsApp
callers get is set with `TRAVEL_VOICE_STT_PROVIDER`,
`TRAVEL_VOICE_LLM_PROVIDER` and `TRAVEL_VOICE_TTS_PROVIDER`; leave them blank
and it is OpenAI for audio and Claude for the brain, as before. Keys:
`ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`, `IONOS_API_KEY` — details in
`server/.env.example`, and the Integrations panel probes each one.

**The brain is the cheapest part, so it is not where to economise.** On a
voice channel, synthesising the reply costs several cents and thinking of it
costs a fraction of one, so the model is around 2 to 5 percent of what an
exchange costs. The advisor therefore has its own model default, Claude Opus
5 at low effort, separate from the company's. Low effort on the stronger
model is both faster and more accurate here than high effort on a weaker one,
because the questions are bounded and the caller is holding a phone. Every
other agent in the org chart is untouched. Override with `TRAVEL_VOICE_MODEL`
and `TRAVEL_VOICE_EFFORT`.

**Every reply is checked before it is spoken.** A weaker or cheaper brain
sometimes ignores the instruction to answer in the caller's language, and on
a voice channel that is a total loss rather than a degraded answer. So a
reply confidently in the wrong language is asked for again once, and the
corrected one is what the caller hears; the tab says when that happened, so
you can see which brain needs it. An overlong reply is not retried, since the
text message carries the words intact. Only the audio is cut, at the last
full sentence that fits.

**All three languages work on every provider.** One subtlety is worth knowing:
a Deepgram Aura voice id carries its own language, so each language needs a
named voice or it cannot be spoken. Rather than pin a French id that might not
exist, the advisor asks Deepgram which voices your key can see and picks one.
That means a language Deepgram adds works without a redeploy, and the
Integrations panel tells you which languages Aura can really speak rather than
assuming all three.

**It also translates.** Anyone talking to the advisor can send `TRANSLATE EN`
and every message after that comes back in English, spoken and written, ready
to forward to an airline desk. `TRANSLATE ES FR` opens a two-way channel, so
one WhatsApp thread sits between a Spanish agent and a French client and each
hears their own language. `TRANSLATE OFF` hands the conversation back to the
advisor. `TRADUCIR` and `TRADUIRE` do the same thing, because the people who
need this do not work in English.

It needs no new provider and no configuration. It runs on the same brain, ears
and voice, which is why it exists today rather than after the media bridge.
What makes it a travel translator rather than a generic one is that IATA
codes, Amadeus entries, record locators, fare bases, prices and dates are held
back from translation, and anything that goes missing anyway is reported to
the caller. A locator reinserted in the wrong place reads as correct, which is
more dangerous than one that is visibly absent.

**The demo runs without a browser, on one number.** Everything the tab does
is also a WhatsApp command from your own allowlisted phone: `TRAVEL STATUS`
for what is live and what it has spent, `TRAVEL INVITE <number> [es|fr|en]`
to let someone try it and send them a spoken hello in the demo voice,
`TRAVEL VOICE deepgram` to switch a provider mid-demo, `TRAVEL LOG` for the
recent conversations, and `TRAVEL GUESTS` or `TRAVEL REMOVE <number>` for the
guest list. Send `TRAVEL` for the list.

Eight further dials are settable the same way, so the things you reach for
mid-demo are not a redeploy away: the voice of whichever speech provider is
live, a pinned answer language, how long the spoken answer may run, the
brain's effort and model, whether the words go out alongside the voice note,
whether a wrong-language answer is re-asked, and the per-caller hourly limit.
`TRAVEL SETTINGS` shows each one and whether its value came from the
environment or from your phone; `TRAVEL LENGTH 90` sets one; `TRAVEL
DEFAULTS` puts every switch and dial back. The environment variables stay the
deployment's base and the phone is an override on top, persisted so a restart
mid-demo does not undo it.

An invited guest reaches the travel advisor and nothing else on that number.
Not the executive team, not the founder commands. The webhook checks the
guest list before the company allowlist and, on a match, calls exactly one
thing, so the boundary is routing rather than a prompt. That is what makes
it safe to hand the number to a prospect, and why you should never widen
`WHATSAPP_ALLOWED_NUMBERS` to run a demo.

To try it from the founder's own WhatsApp line without a second number, send
`TRAVEL ON`; every message after that, voice or text, goes to the advisor
until `TRAVEL OFF`. The tab's sidebar can reach out first — an introduction,
a call-permission request and a spoken message to a number you name — and
puts the advisor on the portfolio as a venture so the team can sell it.

**Live calls.** Meta's Business Calling API is wired for signalling (asking
permission, placing, accepting, ending, and every webhook event) but the
audio of a live call travels over WebRTC and needs a media gateway this
repository does not carry. Until one is registered through
`setMediaBridge()` in `server/travelVoice/calls.js`, an incoming call is
declined and the caller is told, in their language, to send a voice note.
Voice notes are the product today; live calls are the fourth milestone.

**What the research changed.** A deep research pass in September 2026 —
what the leading voice companies run, the state of real-time speech, and what
Deloitte, PwC, EY and KPMG advise on enterprise voice agents, applied to this
product (`reports/Voice AI stack for travel advisor.md`) — recommended keeping
the cascade and hardening its boundaries. Every recommendation is built:

- *Codes survive the voice.* A locator heard in a voice note is read back in
  the caller's spelling alphabet ("X de Xiquena, 7, K de Kilo") before the
  answer; IATA codes and entries are spelled letter by letter, prices and dates
  said the way each language says them, and the written twin keeps every code
  exactly as the model wrote it (`spoken.js`). In translation, codes are swapped
  for placeholders before the model sees the text and put back after
  (`translate.js`).
- *Money only from a source.* Every fare, fee or compensation figure is checked
  against the turn's tool results and the caller's words; one with no source
  gets one correction and is recorded (`grounding.js`). The prompt pins the
  formal register (usted, vous), keeps EU261 to the case and the band, and
  forbids inferring anything about the person. A test walks every ear's
  requests to confirm none asks for speaker identification or sentiment.
- *First contact is disclosed, and voice waits for consent.* The first message
  from any number gets a spoken and written AI notice with two reply buttons;
  by default a voice note is not downloaded until the caller taps agree, and
  text is answered meanwhile. The tap is kept with Meta's message id.
  `BORRAR` / `SUPPRIMER` / `DELETE` forgets them. Every synthesised note carries
  an AI-generated marker inside the file (`consent.js`, `ogg.js`).
- *A person, with the authority to overrule.* `AGENTE` / `CONSEILLER` /
  `AGENT`, the advisor's own `request_human` tool, or `TRAVEL TAKE` hands a
  conversation to `TRAVEL_VOICE_ESCALATION_NUMBERS`; `TRAVEL SAY` answers through
  the advisor's number and `TRAVEL RESUME` hands back. Everything is logged
  (`escalation.js`).
- *An audit trail, retention clocks, a sample a person reads, numbers per
  language.* Every turn leaves a wordless line in an append-only trail with a
  salted caller hash, the consent state, the providers, model and prompt
  fingerprint, cost, timings and every quality flag. Transcripts are forgotten
  after 180 days, the review sample after a year, the trail after five. A few
  per cent of turns go to `TRAVEL REVIEW`. `TRAVEL METRICS` and the tab's panel
  give answers, cost, latency, wrong-language, ungrounded, code and handoff
  rates per language, and cost per resolved conversation (`audit.js`).
- *Residency.* `TRAVEL_VOICE_RESIDENCY=eu` refuses any provider not declared
  EU-hosted; Claude runs in the EU through `ANTHROPIC_GATEWAY=bedrock|vertex`
  in an EU region without changing the brain (`residency.js`,
  `agents/anthropicClient.js`). A fourth ear, AssemblyAI, is there for
  code-switched speech; Deepgram can be told the Amadeus vocabulary; a clip
  under two seconds cannot switch a conversation's language; ElevenLabs is
  asked not to log and `TRAVEL TIER FAST` moves it to the low-latency model.
- *Simulate, then judge.* `npm run travel:qa` plays six callers through the
  advisor as it ships, applies deterministic rules and has a judge model score
  each conversation; `npm run travel:bench -- fixtures/` runs every ear over
  your own voice notes and reports word error rate, chrF and entity error rate
  per ear per language (`qa/`, `bench/`). A pre-filled data protection impact
  assessment is at `docs/travel-voice-dpia.md`.

What the research could not settle is left as it is: the WebRTC/SIP media
bridge stays unbuilt until the WhatsApp Calling API is confirmed to stream
media to a machine agent, and an in-signal audio watermark needs a vendor with
one. Each default above is the safe one; every one can be lowered from the
phone, and `TRAVEL STATUS` says when it has been.

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
