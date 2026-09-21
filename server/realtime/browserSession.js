// A real-time conversation without a phone company.
//
// The Twilio path exists because WhatsApp calling is WebRTC over UDP and
// Railway does not accept inbound UDP, so the media has to be terminated by
// somebody who does. That is the right answer for a published phone number
// and an absurd one for a prototype: an account, a card, a number, per-minute
// telephony, and a provider migration that would rewrite messaging already
// proven working in Spanish and French.
//
// The browser sidesteps all of it. The Realtime API speaks WebRTC directly to
// a browser, so the audio goes founder's phone <-> OpenAI and never touches
// this server at all. Railway's UDP restriction stops mattering because
// Railway is not in the media path.
//
// What is left for the server is the part that must not happen in a browser:
// minting the credential. A page cannot hold OPENAI_API_KEY — anyone who
// opens devtools owns the account — so it gets a short-lived token instead,
// scoped to one session and expiring in about a minute.

import { readSecret } from '../env.js';
import { realtimeModel, realtimeVoice, ASK_THE_TEAM } from './openaiRealtime.js';
import { buildCallInstructions, callGreeting } from './callBrief.js';

const SESSION_URL = 'https://api.openai.com/v1/realtime/sessions';

/** Whether a browser conversation can be started at all. */
export function isBrowserCallConfigured() {
  return Boolean(readSecret('OPENAI_API_KEY'));
}

/**
 * Mints an ephemeral session for one browser conversation.
 *
 * The instructions, voice, tools and turn detection are all fixed here rather
 * than sent by the page. A browser can be edited by whoever holds the phone,
 * so anything the page could choose is something an attacker could choose:
 * the brief that says "do not promise anything to anyone outside the company"
 * has to be server-side or it is decorative.
 *
 * Audio format is left to the API's default rather than forced to g711_ulaw —
 * that was Twilio's constraint, and a browser gets full-band Opus instead,
 * which is the better-sounding half of this whole feature.
 */
export async function mintBrowserSession() {
  const apiKey = readSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set, so there is nothing to talk to.');

  const response = await fetch(SESSION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: realtimeModel(),
      voice: realtimeVoice(),
      instructions: buildCallInstructions({}),
      // Same reason as the phone line: the founder should not have to hold a
      // button, and a conversation has no push-to-talk.
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
      },
      input_audio_transcription: { model: 'whisper-1' },
      tools: [ASK_THE_TEAM],
      tool_choice: 'auto',
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`Could not start a conversation (${response.status}): ${detail.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const body = await response.json();
  const token = body?.client_secret?.value;
  if (!token) throw new Error('OpenAI returned a session with no client secret, so the browser has nothing to connect with.');

  return {
    token,
    expiresAt: body?.client_secret?.expires_at || null,
    model: realtimeModel(),
    // The page speaks these out loud on connect; sending them back means the
    // greeting is decided here too rather than by whatever the page feels like.
    greeting: callGreeting(),
  };
}
