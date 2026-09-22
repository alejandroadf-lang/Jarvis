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
import { buildDeskInstructions, deskGreeting } from './deskBrief.js';
import { buildSupportInstructions, supportGreeting, supportDeskName, SUPPORT_TOOLS } from './supportDesk.js';
import { getVenture } from '../finance/ventures.js';

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
export async function mintBrowserSession({ desk = '', support = false } = {}) {
  const apiKey = readSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set, so there is nothing to talk to.');

  // Three callers, three briefs. The support desk is the third: no company
  // state, no venture, its own two tools, and a brief that cannot introduce
  // itself as the vendor whose users it helps.
  const isSupport = Boolean(support);

  // Two callers, two briefs, and the difference is not cosmetic. The founder's
  // brief carries COMPANY STATE — revenue, pipeline, prospect names. A desk
  // session must never see it, so the branch happens here rather than by
  // passing a flag down into one shared prompt where a future edit could let
  // the company state through.
  const isDesk = Boolean(desk) && !isSupport;
  const venture = isDesk ? getVenture(desk) : null;
  if (isDesk && !venture) {
    throw new Error(`There is no venture "${desk}", so a caller would reach a desk with no product to describe.`);
  }

  const response = await fetch(SESSION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: realtimeModel(),
      voice: realtimeVoice(),
      instructions: isSupport ? buildSupportInstructions() : isDesk ? buildDeskInstructions(desk) : buildCallInstructions({}),
      // Same reason as the phone line: the founder should not have to hold a
      // button, and a conversation has no push-to-talk.
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
      },
      input_audio_transcription: { model: 'whisper-1' },
      // A desk gets no tools at all. ask_the_team runs a real company turn
      // whose answer is written for the founder and would be read out to a
      // stranger — and it is also how a caller could make this company do
      // work by asking. The desk answers from what it was given or takes a
      // message.
      tools: isSupport ? SUPPORT_TOOLS : isDesk ? [] : [ASK_THE_TEAM],
      tool_choice: isDesk ? 'none' : 'auto',
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
    greeting: isSupport ? supportGreeting() : isDesk ? deskGreeting(venture) : callGreeting(),
    desk: isSupport ? supportDeskName() : isDesk ? venture.title : '',
    support: isSupport,
  };
}
