// WhatsApp voice calls: the signalling half of "call someone on WhatsApp".
//
// Meta's Business Calling API (Cloud API, `/{PHONE_NUMBER_ID}/calls`) lets a
// business ring a WhatsApp user, and lets a user ring the business. It has
// two halves that are worth keeping apart in one's head:
//
//   SIGNALLING — asking permission, placing the call, accepting, hanging
//   up, and the webhook events that report each step. Plain HTTPS and JSON,
//   fully implemented here.
//
//   MEDIA — the audio itself, which travels over WebRTC (SRTP, Opus) once
//   the SDP offer and answer have been exchanged through the signalling
//   above. That needs a WebRTC stack that can terminate the call, hand the
//   caller's audio to transcription and play synthesised speech back. Not
//   something a pure-JavaScript server does on its own; it is a media
//   gateway, and it plugs in here through `setMediaBridge()`.
//
// Without a bridge registered, the advisor does not pretend. An incoming
// call is declined and the caller is told, in their language, to send a
// voice note instead; an outbound "call" becomes a permission request plus
// a voice message. Everything a caller can do today works end to end, and
// the day a media bridge exists, nothing above this file changes.
//
// Two rules of the API are load-bearing:
//
//   1. A business may only ring a user who has granted permission, asked
//      for through an interactive `call_permission_request` message. The
//      answer comes back on the messages webhook (see extractMessage in
//      channels/whatsapp.js) and is remembered per number here.
//   2. Every call event — connect, terminate, status — arrives on the same
//      webhook as messages, under the `calls` field, and must be acknowledged
//      with a 200 just as fast.

import { GRAPH_API, normalizeNumber, sendWhatsAppPayload } from '../channels/whatsapp.js';
import { readJson, writeJson } from '../store.js';

const FILE = 'travelVoiceCalls.json';
const MAX_EVENTS = 100;

// --- the media bridge -------------------------------------------------------

let mediaBridge = null;

/**
 * Registers the thing that carries audio. The contract is deliberately small:
 *
 *   {
 *     // Business-initiated: produce the SDP offer the call is placed with,
 *     // then learn the user's answer once they pick up.
 *     createOffer(callContext): Promise<string>,
 *     acceptAnswer(callId, sdpAnswer): Promise<void>,
 *     // User-initiated: answer the user's offer.
 *     answerOffer(callId, sdpOffer, callContext): Promise<string>,
 *     // Hang-up, from either side.
 *     close(callId): Promise<void>,
 *   }
 *
 * The bridge owns the WebRTC session and is expected to drive the advisor
 * itself (transcribe what it hears, call runTravelVoiceTurn, speak the reply)
 * — the shape of that loop belongs with the media stack, not here.
 */
export function setMediaBridge(bridge) {
  mediaBridge = bridge || null;
}

export function hasMediaBridge() {
  return Boolean(mediaBridge);
}

// --- permissions ------------------------------------------------------------

function load() {
  const data = readJson(FILE, { permissions: {}, events: [] });
  if (!data.permissions) data.permissions = {};
  if (!Array.isArray(data.events)) data.events = [];
  return data;
}

function save(data) {
  writeJson(FILE, data);
}

/**
 * Whether a number has said the business may ring it. Permissions expire —
 * Meta's default is 72 hours unless the user grants a permanent one — so the
 * timestamp is honoured rather than the mere presence of a record.
 */
export function hasCallPermission(number) {
  const record = load().permissions[normalizeNumber(number)];
  if (!record || record.response !== 'accept') return false;
  if (record.permanent) return true;
  if (!record.expiresAt) return true;
  return Number(record.expiresAt) * 1000 > Date.now();
}

/** Records the caller's answer to a permission request, from the webhook. */
export function recordCallPermission(number, { response, expiresAt = null, permanent = false }) {
  const data = load();
  data.permissions[normalizeNumber(number)] = {
    response,
    expiresAt,
    permanent: Boolean(permanent),
    at: new Date().toISOString(),
  };
  save(data);
  return data.permissions[normalizeNumber(number)];
}

/** The interactive message that asks a user whether the business may call. */
export function callPermissionRequestPayload() {
  return {
    type: 'interactive',
    interactive: {
      type: 'call_permission_request',
      action: { name: 'call_permission_request' },
    },
  };
}

export async function requestCallPermission(to, { phoneNumberId }) {
  const result = await sendWhatsAppPayload(to, callPermissionRequestPayload(), { phoneNumberId });
  recordEvent({ kind: 'permission_requested', number: to });
  return result;
}

// --- calls ------------------------------------------------------------------

async function callsApi(phoneNumberId, body) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token || !phoneNumberId) throw new Error('WhatsApp is not configured (token or phone number id missing)');

  const res = await fetch(`${GRAPH_API}/${phoneNumberId}/calls`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`WhatsApp calls API refused ${body.action} (${res.status}): ${detail}`);
  }
  return data;
}

/**
 * Places a business-initiated call. Refuses without permission and without a
 * media bridge, because a call with nobody on the line is worse than no call.
 *
 * @returns {Promise<{ callId: string }>}
 */
export async function startCall(to, { phoneNumberId, context = {} }) {
  if (!hasCallPermission(to)) {
    throw new Error('This number has not granted call permission yet. Send a call permission request first and wait for the reply.');
  }
  if (!mediaBridge) {
    throw new Error('No media bridge is registered, so a live call would have no audio. See travelVoice/calls.js.');
  }
  const sdp = await mediaBridge.createOffer({ to, ...context });
  const data = await callsApi(phoneNumberId, {
    to: normalizeNumber(to),
    action: 'connect',
    session: { sdp_type: 'offer', sdp },
  });
  const callId = data?.calls?.[0]?.id || null;
  recordEvent({ kind: 'call_started', number: to, callId });
  return { callId };
}

export async function acceptCall(callId, { phoneNumberId, sdpAnswer }) {
  const data = await callsApi(phoneNumberId, {
    call_id: callId,
    action: 'accept',
    session: { sdp_type: 'answer', sdp: sdpAnswer },
  });
  recordEvent({ kind: 'call_accepted', callId });
  return data;
}

export async function rejectCall(callId, { phoneNumberId }) {
  const data = await callsApi(phoneNumberId, { call_id: callId, action: 'reject' });
  recordEvent({ kind: 'call_rejected', callId });
  return data;
}

export async function terminateCall(callId, { phoneNumberId }) {
  const data = await callsApi(phoneNumberId, { call_id: callId, action: 'terminate' });
  recordEvent({ kind: 'call_terminated', callId });
  if (mediaBridge) await mediaBridge.close(callId).catch(() => {});
  return data;
}

// --- webhook events ---------------------------------------------------------

/**
 * Pulls a call event out of the webhook payload, or null when the payload is
 * something else (a message, a receipt). Call events and message events share
 * the webhook but never the same entry.
 *
 * @returns {null | { id, from, to, event, direction, status, sdp, sdpType, phoneNumberId, timestamp }}
 */
export function extractCallEvent(body) {
  const change = body?.entry?.[0]?.changes?.[0];
  if (!change || change.field !== 'calls') return null;
  const value = change.value;
  const call = value?.calls?.[0];
  if (!call) return null;

  return {
    id: call.id,
    from: call.from,
    to: call.to,
    // 'connect' carries the SDP; 'terminate' closes it. Status updates (ringing,
    // accepted, rejected) arrive under `status` on some events and under a
    // separate `statuses` array on others — both are read.
    event: call.event || (value?.statuses?.[0] ? 'status' : null),
    direction: call.direction || null,
    status: call.status || value?.statuses?.[0]?.status || null,
    sdp: call.session?.sdp || null,
    sdpType: call.session?.sdp_type || null,
    phoneNumberId: value?.metadata?.phone_number_id || null,
    timestamp: call.timestamp || null,
  };
}

/**
 * Handles one call event end to end.
 *
 * With a bridge: a user's incoming call is answered and handed to the bridge;
 * a business call's answer is passed on; a hang-up closes the session.
 * Without one: an incoming call is declined and the caller gets a text in
 * their language pointing at voice notes, via `onDeclined`.
 *
 * @returns {Promise<{ action: string }>}
 */
export async function handleCallEvent(event, { phoneNumberId, onDeclined = async () => {} }) {
  const number = phoneNumberId || event.phoneNumberId;
  recordEvent({ kind: `event:${event.event || 'unknown'}`, callId: event.id, number: event.from, status: event.status, direction: event.direction });

  if (event.event === 'connect' && event.direction === 'USER_INITIATED') {
    if (!mediaBridge) {
      await rejectCall(event.id, { phoneNumberId: number }).catch((err) =>
        console.warn(`Travel voice: could not reject call ${event.id}: ${err.message}`)
      );
      await onDeclined(event);
      return { action: 'declined_no_bridge' };
    }
    const answer = await mediaBridge.answerOffer(event.id, event.sdp, { from: event.from });
    await acceptCall(event.id, { phoneNumberId: number, sdpAnswer: answer });
    return { action: 'accepted' };
  }

  if (event.event === 'connect' && event.direction === 'BUSINESS_INITIATED') {
    if (mediaBridge && event.sdp) await mediaBridge.acceptAnswer(event.id, event.sdp);
    return { action: 'answered' };
  }

  if (event.event === 'terminate') {
    if (mediaBridge) await mediaBridge.close(event.id).catch(() => {});
    return { action: 'closed' };
  }

  return { action: 'noted' };
}

// --- log --------------------------------------------------------------------

function recordEvent(entry) {
  try {
    const data = load();
    data.events.push({ at: new Date().toISOString(), ...entry, number: entry.number ? normalizeNumber(entry.number) : undefined });
    if (data.events.length > MAX_EVENTS) data.events = data.events.slice(-MAX_EVENTS);
    save(data);
  } catch (err) {
    console.error('Travel voice: could not record a call event:', err.message);
  }
}

export function recentCallEvents(limit = 30) {
  return load().events.slice(-limit).reverse();
}

export function __resetCallsForTests() {
  writeJson(FILE, { permissions: {}, events: [] });
  mediaBridge = null;
}
