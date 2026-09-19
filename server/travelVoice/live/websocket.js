// The wire for a live call, and the first one that exists.
//
// A WebSocket carrying raw PCM16 frames up and synthesised audio down. It
// is not the transport the product ultimately wants — that is WhatsApp —
// but it is the one that can be built and used today, in the Travel Voice
// tab, with the keys already configured. Which matters for more than a
// demo: the session it drives (session.js) is the same object a WhatsApp
// media gateway would drive, so everything hard about a live call gets
// exercised for real, by people, long before the gateway exists.
//
// The protocol is deliberately dull:
//
//   up    binary frames of PCM16 little-endian mono at 16 kHz, and JSON
//         control messages: {type:'hello', ...}, {type:'played'}, {type:'bye'}
//   down  the session's own JSON messages — state, transcript, reply,
//         audio (base64), interrupt, error
//
// `played` is the one that is easy to miss and load-bearing: the browser
// says when the audio has actually finished coming out of the speaker.
// Without it the server goes back to listening while the caller is still
// hearing the answer, and every reply barges in on itself.

import { WebSocketServer } from 'ws';
import { LiveSession } from './session.js';
import { isTravelVoiceCallerAllowed } from '../index.js';

const PATH = '/api/travel-voice/live';

/** A transport over one socket, in the shape session.js expects. */
export function socketTransport(socket) {
  let awaiting = null;
  return {
    send(message) {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(message));
    },
    close() {
      try {
        socket.close();
      } catch {
        // Already gone.
      }
    },
    /** Resolves when the browser says the audio finished playing. */
    waitForPlayback() {
      return new Promise((resolve) => {
        awaiting = resolve;
      });
    },
    played() {
      const resolve = awaiting;
      awaiting = null;
      resolve?.();
    },
    /** A socket that dies mid-answer must not leave the session waiting. */
    abandon() {
      this.played();
    },
  };
}

/**
 * Attaches the live-call endpoint to an HTTP server.
 *
 * @param {import('node:http').Server} server
 * @param {object} deps
 * @param {object} deps.anthropic
 * @param {(session: LiveSession, info: object) => void} [deps.onSession]
 * @param {(turn: object, info: object) => Promise<void>} [deps.onTurn]
 */
export function attachLiveCalls(server, { anthropic, onSession = null, onTurn = null } = {}) {
  const wss = new WebSocketServer({ server, path: PATH });
  const sessions = new Set();

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    const sessionId = `live-${(url.searchParams.get('sessionId') || Math.random().toString(36).slice(2)).replace(/[^\w-]/g, '')}`;
    const number = url.searchParams.get('number') || null;

    // The same door as every other channel. A tab cannot reach the advisor
    // from a number the deployment has shut out.
    if (number && !isTravelVoiceCallerAllowed(number)) {
      socket.send(JSON.stringify({ type: 'error', detail: 'That number is outside TRAVEL_VOICE_ALLOWED_NUMBERS.' }));
      socket.close();
      return;
    }

    const transport = socketTransport(socket);
    const session = new LiveSession({
      sessionId,
      number,
      anthropic,
      transport,
      language: url.searchParams.get('language') || null,
      providers: {
        stt: url.searchParams.get('stt') || undefined,
        llm: url.searchParams.get('llm') || undefined,
        tts: url.searchParams.get('tts') || undefined,
      },
      onTurn: onTurn ? (turn) => onTurn(turn, { sessionId, number }) : null,
    });
    sessions.add(session);
    onSession?.(session, { sessionId, number });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        session.pushAudio(data);
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return; // A frame we cannot read is not worth closing a call over.
      }
      if (message.type === 'played') transport.played();
      if (message.type === 'bye') session.end('hung-up');
    });

    socket.on('close', () => {
      // Release anything waiting on playback before ending, or an answer
      // in flight keeps a dead call alive until it times out.
      transport.abandon();
      session.end('disconnected');
      sessions.delete(session);
    });
    socket.on('error', () => {
      transport.abandon();
      session.end('socket-error');
      sessions.delete(session);
    });

    session.on('error', (err) => console.warn(`Travel voice live: ${err.message}`));
    session.start().catch((err) => {
      console.error('Travel voice live: could not start a call:', err.message);
      session.end('failed-to-start');
    });
  });

  return {
    path: PATH,
    wss,
    live: () => [...sessions].map((s) => s.summary()),
    close: () => {
      for (const session of sessions) session.end('server-closing');
      wss.close();
    },
  };
}

export const LIVE_PATH = PATH;
