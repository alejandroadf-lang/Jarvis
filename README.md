# Jarvis

A personal voice assistant. React chat UI (with browser speech-to-text and
text-to-speech) talking to an Express backend that calls the Claude API.

It also ships two more modes built the same way — a hierarchy of Claude
agents that delegate to each other via tool use:

- **Executive Team**: a virtual IT-company org chart (CEO, CTO, CFO, CMO,
  COO, and their department leads) that answers requests by routing them to
  the right department.
- **Venture Studio**: a brainstorming team (Venture Partner, Market
  Researcher, Ideation Facilitator, Business Case Analyst, Validation
  Critic) that helps find and pressure-test the next idea, then turns it
  into a funded venture — tracked against a real $100 seed-capital ledger —
  and hands it to the Executive Team to build.

See [ORG_STRUCTURE.md](./ORG_STRUCTURE.md) for the full architecture,
roster, and how capital flows from idea to execution.

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

## Production

```bash
npm run build   # builds client into client/dist
npm start       # starts the server, which serves the built client + API
```

Voice input/output relies on the browser's Web Speech API (Chrome/Edge have
the best support; Safari and Firefox support varies). Conversation history is
kept in server memory per browser session — there's no database yet, so it's
lost on server restart.

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
