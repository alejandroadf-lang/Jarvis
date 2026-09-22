// The phone line.
//
// Twilio answers the number, asks this server what to do, and gets back TwiML
// saying "open a media stream to this WebSocket". From then on Twilio and this
// process exchange 20ms frames of G.711 μ-law audio as base64 JSON, and this
// file's whole job is to sit between that stream and the realtime model
// without adding latency to either direction.
//
// Three things here are not obvious and all three are audible if wrong:
//
//   1. Interruption has two halves. Telling the model to stop is not enough —
//      Twilio has already buffered audio it will keep playing. Both have to be
//      cut, or the caller talks over a voice that answers a question from
//      several seconds ago.
//   2. The stream SID is not known until Twilio's `start` event, and nothing
//      can be sent back before it arrives.
//   3. A call that fails has to fail out loud. A silent line is indis-
//      tinguishable from a broken number, and the founder will assume the
//      latter and stop trying.

import { WebSocketServer } from 'ws';
import { openRealtimeSession, ASK_THE_TEAM } from './openaiRealtime.js';
import { buildCallInstructions, callGreeting } from './callBrief.js';
import { refuseCall, maxCallSeconds, recordCallSeconds, callMode } from './callPolicy.js';
import { buildSupportInstructions, supportGreeting, SUPPORT_TOOLS, runSupportTool } from './supportDesk.js';

/**
 * TwiML for an incoming call.
 *
 * A refusal is spoken rather than dropped: the founder hearing "this number is
 * not on the call allowlist" knows exactly which variable to set, where a dead
 * line tells them nothing.
 */
export function answerCallTwiml({ from, host }) {
  const refusal = refuseCall(from);
  if (refusal) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(refusal)}</Say><Hangup/></Response>`;
  }
  const url = `wss://${host}/api/calls/stream`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Connect><Stream url="${escapeXml(url)}"><Parameter name="from" value="${escapeXml(from || '')}"/></Stream></Connect></Response>`
  );
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wires the media-stream WebSocket onto an existing HTTP server.
 *
 * @param {import('http').Server} server
 * @param {object} deps
 * @param {(question: string) => Promise<string>} deps.askTheTeam - runs a real
 *   company turn. Injected rather than imported so this file stays testable
 *   without booting the org chart, and so the slow path is visible at the
 *   wiring rather than buried three files down.
 * @param {(entry: object) => void} [deps.onCallEnded]
 */
export function attachCallStream(server, { askTheTeam, onCallEnded = () => {} }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    // Adding any upgrade listener makes this server responsible for every
    // upgrade: Node only destroys unhandled ones while nobody is listening. A
    // bare `return` here leaves the socket open forever, so an upgrade to the
    // wrong path becomes a leak rather than a refusal.
    let pathname = '';
    try {
      pathname = new URL(request.url, 'http://placeholder').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== '/api/calls/stream') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (twilio) => {
    let streamSid = '';
    let session = null;
    let from = '';
    const startedAt = Date.now();
    const transcript = [];
    let closed = false;
    let hangupTimer = null;

    function toTwilio(event) {
      if (twilio.readyState === twilio.OPEN) twilio.send(JSON.stringify(event));
    }

    function endCall(reason) {
      if (closed) return;
      closed = true;
      if (hangupTimer) clearTimeout(hangupTimer);
      const seconds = (Date.now() - startedAt) / 1000;
      recordCallSeconds(seconds);
      try {
        session?.close();
      } catch {
        // Nothing to do; the call is over either way.
      }
      try {
        twilio.close();
      } catch {
        // Same.
      }
      onCallEnded({ from, seconds, reason, transcript: transcript.slice() });
    }

    // A session that cannot open must end the call, not throw into Twilio's
    // message handler. The commonest cause is a missing OPENAI_API_KEY, and an
    // exception here would take the socket down with no explanation anywhere
    // the founder would think to look.
    function startSession() {
      try {
        session = buildSession();
      } catch (err) {
        console.error('Call: could not open the realtime session:', err.message);
        endCall('session-failed');
      }
    }

    function buildSession() {
      // Decided at the moment the call connects, from CALL_MODE. A support
      // line gets the support brief and the support tools and never the
      // founder's — the founder's brief carries company state, and a public
      // number answered with it is a leak to whoever dials.
      const support = callMode() === 'support';
      return openRealtimeSession({
        instructions: support ? buildSupportInstructions() : buildCallInstructions({}),
        greeting: support ? supportGreeting() : callGreeting(),
        tools: support ? SUPPORT_TOOLS : [ASK_THE_TEAM],

        onAudio(base64) {
          if (!streamSid) return;
          toTwilio({ event: 'media', streamSid, media: { payload: base64 } });
        },

        // Both halves of an interruption. Cancelling the model stops it
        // generating; clearing Twilio drops what it has already buffered and
        // would otherwise keep playing into the caller's sentence.
        onSpeechStarted() {
          session?.interrupt();
          if (streamSid) toTwilio({ event: 'clear', streamSid });
        },

        onTranscript(text) {
          transcript.push({ who: support ? 'caller' : 'founder', text });
        },

        onToolCall({ id, name, args }) {
          // The desk's tools are fast — a lookup is milliseconds, a ticket
          // is a file write and an email — so they complete in place rather
          // than through the ask-then-deliver dance below.
          if (name === 'lookup_issue' || name === 'open_ticket') {
            transcript.push({ who: 'desk', text: `${name}: ${JSON.stringify(args || {})}` });
            runSupportTool(name, args || {}, { from })
              .then((out) => session?.completeToolCall(id, out))
              .catch((err) => session?.completeToolCall(id, `That failed: ${err.message}. Tell the caller plainly and offer a ticket.`));
            return;
          }
          if (name !== 'ask_the_team' || support) return;
          const question = String(args?.question || '').trim();
          if (!question) {
            session?.completeToolCall(id, 'No question was passed, so nothing was asked.');
            return;
          }

          transcript.push({ who: 'asked the team', text: question });
          // Acknowledged immediately so the tool call is not left open for
          // fifteen seconds — the model needs to be free to keep talking.
          session?.completeToolCall(
            id,
            'Asked. The answer will arrive during this call; keep the conversation going until it does.'
          );

          askTheTeam(question)
            .then((answer) => {
              if (closed) return;
              transcript.push({ who: 'team', text: answer });
              session?.deliver(
                `The team has answered the question you put to them ("${question}"). ` +
                  `Tell the founder their answer has come back, then give it in your own words, briefly, ` +
                  `in the language of this call:\n\n${answer}`
              );
            })
            .catch((err) => {
              if (closed) return;
              // Said out loud rather than swallowed. The caller was told the
              // question was being asked, so silence afterwards is a broken
              // promise they have no way to detect.
              session?.deliver(
                `The question you put to the team failed: ${err.message}. Tell the founder plainly that ` +
                  'it did not go through, and offer to try again.'
              );
            });
        },

        onError(err) {
          console.error('Call: realtime session error:', err.message);
        },

        onClose() {
          endCall('model-closed');
        },
      });
    }

    twilio.on('message', (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (event.event) {
        case 'start':
          streamSid = event.start?.streamSid || '';
          from = event.start?.customParameters?.from || '';
          startSession();
          // A hard ceiling the model cannot talk its way past. It has been
          // told the limit and asked to wrap up, but a prompt is a request
          // and a timer is a rule.
          hangupTimer = setTimeout(() => endCall('max-duration'), maxCallSeconds() * 1000);
          break;

        case 'media':
          if (event.media?.payload) session?.sendAudio(event.media.payload);
          break;

        case 'stop':
          endCall('caller-hung-up');
          break;

        default:
          break;
      }
    });

    twilio.on('close', () => endCall('stream-closed'));
    twilio.on('error', () => endCall('stream-error'));
  });

  return wss;
}
