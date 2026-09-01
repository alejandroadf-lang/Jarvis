# Jarvis

A personal voice assistant. React chat UI (with browser speech-to-text and
text-to-speech) talking to an Express backend that calls the Claude API.

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
kept in server memory per browser session — there's no database yet.
