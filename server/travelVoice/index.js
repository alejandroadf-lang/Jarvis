// The travel voice advisor, end to end.
//
// This is the venture's product: someone sends a voice note in Spanish,
// French or English to a WhatsApp number, and a travel-industry advisor
// answers in a voice note in the same language, within the time it takes to
// read a text. It works in a browser tab too, which is how it gets tested
// without a phone, and it can reach out first — a permission request and a
// voice message to a number the founder names.
//
// What this module owns: which number is the advisor's, who may talk to it,
// how often, what each conversation remembers, and the log the founder reads
// to see whether anyone is calling. What it does not own: the model (advisor.
// js), the ears and voice (speech.js), the phone (channels/whatsapp.js,
// calls.js).
//
// The public number is open by default and that is a decision, not an
// oversight. The founder's company line is allowlisted because what sits
// behind it can deploy code and email customers. Behind this one is an agent
// with two read-only tools, a per-caller rate limit and the same daily spend
// cap as everything else. A helpdesk nobody can ring is not a helpdesk.

import { readJson, writeJson } from '../store.js';
import { loadSessions, saveSession, trimHistory } from '../sessionStore.js';
import { createVenture, listVentures } from '../finance/ventures.js';
import {
  downloadMedia,
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  normalizeNumber,
} from '../channels/whatsapp.js';
import { runAdvisorTurn, advisorModel } from './advisor.js';
import { transcribeWithLanguage, synthesizeSpeech, speakable, isSpeechConfigured, canHear, canSpeak, ttsModel, ttsVoice } from './speech.js';
import { isAmadeusConfigured, amadeusEnvironment } from './amadeus.js';
import { describeProviders, hasProvider, resolveProvider } from './providers/index.js';
import {
  resolveLanguage,
  requestedLanguageSwitch,
  normalizeLanguage,
  localized,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
} from './languages.js';
import {
  handleCallEvent,
  requestCallPermission,
  hasCallPermission,
  hasMediaBridge,
  startCall,
  recentCallEvents,
} from './calls.js';

const STATE_FILE = 'travelVoiceState.json';
const SESSION_KIND = 'travel';
const MAX_LOG = 100;
const PREVIEW_CHARS = 120;

export const VENTURE_TITLE = 'Travel Voice Advisor';

// --- configuration ----------------------------------------------------------

/** The advisor's own WhatsApp number id, if the founder gave it one. */
export function travelVoicePhoneNumberId() {
  return (process.env.TRAVEL_VOICE_PHONE_NUMBER_ID || '').trim();
}

/** Whether a webhook delivery to this business number belongs to the advisor. */
export function isTravelVoiceNumber(phoneNumberId) {
  const own = travelVoicePhoneNumberId();
  return Boolean(own && phoneNumberId && String(phoneNumberId) === own);
}

/**
 * The advisor can answer text with only ANTHROPIC_API_KEY; voice in and out
 * need OPENAI_API_KEY as well. Reported as two facts rather than one boolean
 * because "configured" without voice is a text bot, and the founder should
 * see which of the two they have.
 */
export function travelVoiceCapabilities() {
  return {
    text: hasProvider('llm'),
    voice: isSpeechConfigured(),
    hear: canHear(),
    speak: canSpeak(),
    liveFares: isAmadeusConfigured(),
    whatsapp: Boolean(travelVoicePhoneNumberId() && process.env.WHATSAPP_TOKEN),
    liveCalls: hasMediaBridge(),
  };
}

export function isTravelVoiceConfigured() {
  return travelVoiceCapabilities().text;
}

function allowedCallers() {
  return (process.env.TRAVEL_VOICE_ALLOWED_NUMBERS || '')
    .split(',')
    .map(normalizeNumber)
    .filter(Boolean);
}

/** Open to everyone unless the founder narrowed it — see the header. */
export function isTravelVoiceCallerAllowed(from) {
  const allowed = allowedCallers();
  if (!allowed.length) return true;
  return allowed.includes(normalizeNumber(from));
}

// --- rate limiting ----------------------------------------------------------

const turnsByCaller = new Map(); // normalized number -> [timestamps]
const WINDOW_MS = 60 * 60 * 1000;

export function maxTurnsPerHour() {
  const value = Number(process.env.TRAVEL_VOICE_MAX_TURNS_PER_HOUR);
  return Number.isFinite(value) && value > 0 ? value : 20;
}

/**
 * Whether this caller may take another turn, and records it if so. A
 * sliding hour rather than a calendar one, so a burst at 10:59 does not get
 * a fresh allowance at 11:00.
 */
export function admitTurn(callerKey, now = Date.now()) {
  const key = String(callerKey);
  const recent = (turnsByCaller.get(key) || []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= maxTurnsPerHour()) {
    turnsByCaller.set(key, recent);
    return false;
  }
  recent.push(now);
  turnsByCaller.set(key, recent);
  return true;
}

// --- state: languages, advisor mode, log ------------------------------------

function loadState() {
  const data = readJson(STATE_FILE, { languages: {}, advisorMode: {}, log: [] });
  if (!data.languages) data.languages = {};
  if (!data.advisorMode) data.advisorMode = {};
  if (!Array.isArray(data.log)) data.log = [];
  return data;
}

function saveState(data) {
  writeJson(STATE_FILE, data);
}

function rememberLanguage(sessionId, language) {
  const data = loadState();
  data.languages[sessionId] = language;
  saveState(data);
}

function rememberedLanguage(sessionId) {
  return loadState().languages[sessionId] || null;
}

/**
 * Advisor mode on the founder's own line. The founder has one WhatsApp
 * number for talking to the company; to try the advisor from that same
 * phone without a second Meta number, they send TRAVEL ON, talk to the
 * advisor, and send TRAVEL OFF to get the team back. Persisted, because a
 * redeploy mid-demo that silently routed the next voice note to the CEO
 * would be confusing in exactly the wrong moment.
 */
export function parseAdvisorModeCommand(text) {
  const match = String(text || '').trim().match(/^travel\s+(on|off)$/i);
  if (!match) return null;
  return match[1].toLowerCase() === 'on' ? 'on' : 'off';
}

export function setAdvisorMode(number, on) {
  const data = loadState();
  const key = normalizeNumber(number);
  if (on) data.advisorMode[key] = new Date().toISOString();
  else delete data.advisorMode[key];
  saveState(data);
}

export function isAdvisorMode(number) {
  return Boolean(loadState().advisorMode[normalizeNumber(number)]);
}

// Callers are the venture's customers, not the founder, and the log is read
// on a dashboard. The last four digits are enough to tell two conversations
// apart and not enough to ring anyone.
export function maskNumber(number) {
  const digits = normalizeNumber(number);
  if (!digits) return null;
  return `…${digits.slice(-4)}`;
}

function recordTurnLog(entry) {
  try {
    const data = loadState();
    data.log.push({ at: new Date().toISOString(), ...entry });
    if (data.log.length > MAX_LOG) data.log = data.log.slice(-MAX_LOG);
    saveState(data);
  } catch (err) {
    console.error('Travel voice: could not record a turn:', err.message);
  }
}

export function recentTravelVoiceTurns(limit = 50) {
  return loadState().log.slice(-limit).reverse();
}

// --- the turn ---------------------------------------------------------------

function sessionHistory(sessionId) {
  return loadSessions(SESSION_KIND).get(sessionId) || [];
}

/**
 * One exchange with the advisor, from any channel.
 *
 * Takes either text or audio. Returns the transcript, the language it
 * answered in and why, the reply, and — when asked and possible — the reply
 * as speech. Never throws for a missing voice: a caller with no OpenAI key
 * still gets the text, and `audioError` says why there is no sound.
 *
 * @param {object} args
 * @param {object} args.anthropic
 * @param {string} args.sessionId one per caller, any channel
 * @param {string} [args.text]
 * @param {Buffer} [args.audio]
 * @param {string} [args.filename] format hint for the transcriber
 * @param {string} [args.language] what the caller chose, if anything
 * @param {boolean} [args.wantAudio] synthesise the reply
 * @param {{stt?: string, llm?: string, tts?: string}} [args.providers] which
 *   ears, brain and voice to use on this turn; the deployment defaults
 *   otherwise (see providers/index.js)
 */
export async function runTravelVoiceTurn({
  anthropic,
  sessionId,
  text = '',
  audio = null,
  filename = 'voice.ogg',
  language = null,
  wantAudio = false,
  providers = {},
}) {
  const startedAt = Date.now();
  const previous = rememberedLanguage(sessionId);
  let transcript = String(text || '').trim();
  let heard = null;
  let costUsd = 0;
  // Which provider answered each stage, and how long it took — the numbers
  // that make "which ears are better" a comparison rather than an opinion.
  const used = { stt: null, llm: null, tts: null };
  const timings = { sttMs: null, llmMs: null, ttsMs: null };

  if (audio) {
    // The chosen language is a hint to the transcriber, not an override of
    // what it hears: a caller who picked Spanish and then speaks French has
    // changed their mind, and the transcriber says so.
    const result = await transcribeWithLanguage(audio, {
      filename,
      languageHint: normalizeLanguage(language) || previous,
      provider: providers.stt,
    });
    transcript = result.text;
    heard = result.language;
    costUsd += result.costUsd;
    used.stt = result.provider;
    timings.sttMs = result.ms;
    if (!transcript) {
      // The transcriber may still have heard which language the silence was in.
      return {
        transcript: '',
        language: normalizeLanguage(language) || heard || previous || DEFAULT_LANGUAGE,
        empty: true,
        costUsd,
        providers: used,
        timings,
      };
    }
  }

  const switched = requestedLanguageSwitch(transcript);
  const resolved = resolveLanguage({ chosen: switched || language, heard, text: transcript, previous });
  const history = sessionHistory(sessionId);

  const turn = await runAdvisorTurn({ anthropic, provider: providers.llm, history, text: transcript, language: resolved.language });
  costUsd += turn.usage.costUsd;
  used.llm = turn.provider;
  timings.llmMs = turn.ms;
  // Whether the brain answered in the language it was told to, and how long
  // it ran on. Carried out of the turn because it is the evidence behind
  // "this model cannot be trusted on a Spanish line" — see replyCheck.js.
  const quality = { drift: turn.drift, words: turn.words, tooLong: turn.tooLong };

  const trimmed = trimHistory(turn.messages);
  saveSession(SESSION_KIND, sessionId, trimmed);
  rememberLanguage(sessionId, resolved.language);

  let speech = null;
  let audioError = null;
  if (wantAudio && turn.reply) {
    try {
      speech = await synthesizeSpeech(speakable(turn.reply), { language: resolved.language, format: 'opus', provider: providers.tts });
      costUsd += speech.costUsd;
      used.tts = speech.provider;
      timings.ttsMs = speech.ms;
    } catch (err) {
      audioError = err.message;
    }
  }

  return {
    transcript,
    language: resolved.language,
    languageSource: switched ? 'switched' : resolved.source,
    reply: turn.reply,
    toolCalls: turn.toolCalls,
    audio: speech ? { buffer: speech.buffer, mimeType: speech.mimeType, filename: speech.filename } : null,
    audioError,
    usage: turn.usage,
    costUsd,
    providers: used,
    model: turn.model,
    timings,
    ...quality,
    durationMs: Date.now() - startedAt,
  };
}

export function resetTravelVoiceSession(sessionId) {
  saveSession(SESSION_KIND, sessionId, []);
  const data = loadState();
  delete data.languages[sessionId];
  saveState(data);
}

// --- WhatsApp ---------------------------------------------------------------

function isVoiceNote(message) {
  return message.type === 'audio' || message.type === 'voice';
}

function textToo() {
  return (process.env.TRAVEL_VOICE_TEXT_TOO || '').trim().toLowerCase() !== 'false';
}

/**
 * Handles one inbound WhatsApp message for the advisor. Called after the
 * webhook has already acknowledged, verified the signature and deduplicated.
 *
 * Replies in kind: a voice note gets a voice note (and the text, unless
 * turned off — an Amadeus entry is easier to copy than to remember from
 * audio), a text gets a text.
 */
export async function handleTravelVoiceMessage(message, { anthropic, phoneNumberId }) {
  const from = message.from;
  const sessionId = `whatsapp-${normalizeNumber(from)}`;
  const send = (text) => sendWhatsAppMessage(from, text, { phoneNumberId });
  // The language for anything said before the advisor has answered — a
  // rate-limit notice, an apology. A returning caller has one on record; a
  // new one who typed is guessed from their words; a new one who spoke gets
  // English until the transcriber has heard them.
  const previous =
    rememberedLanguage(sessionId) ||
    (message.text?.trim() ? resolveLanguage({ text: message.text }).language : DEFAULT_LANGUAGE);
  const startedAt = Date.now();

  if (!admitTurn(sessionId)) {
    recordTurnLog({ channel: 'whatsapp', from: maskNumber(from), stage: 'rate_limited', language: previous });
    await send(localized('rateLimited', previous));
    return { stage: 'rate_limited' };
  }

  let audio = null;
  let filename = 'voice.ogg';
  if (isVoiceNote(message) && message.mediaId) {
    if (!canHear()) {
      recordTurnLog({ channel: 'whatsapp', from: maskNumber(from), stage: 'unsupported_type', language: previous, detail: 'voice note with no speech-to-text provider configured' });
      await send(localized('unsupportedType', previous));
      return { stage: 'unsupported_type' };
    }
    try {
      const media = await downloadMedia(message.mediaId);
      audio = media.buffer;
      filename = media.filename;
    } catch (err) {
      recordTurnLog({ channel: 'whatsapp', from: maskNumber(from), stage: 'failed', language: previous, detail: err.message });
      await send(localized('transcriptionFailed', previous));
      return { stage: 'failed', error: err.message };
    }
  } else if (!message.text?.trim()) {
    recordTurnLog({ channel: 'whatsapp', from: maskNumber(from), stage: 'unsupported_type', language: previous, detail: `type: ${message.type}` });
    await send(localized('unsupportedType', previous));
    return { stage: 'unsupported_type' };
  }

  let result;
  try {
    result = await runTravelVoiceTurn({
      anthropic,
      sessionId,
      text: audio ? '' : message.text,
      audio,
      filename,
      wantAudio: Boolean(audio) && canSpeak(),
    });
  } catch (err) {
    recordTurnLog({ channel: 'whatsapp', from: maskNumber(from), stage: 'failed', language: previous, detail: err.message, durationMs: Date.now() - startedAt });
    await send(localized('answerFailed', previous));
    return { stage: 'failed', error: err.message };
  }

  if (result.empty) {
    recordTurnLog({ channel: 'whatsapp', from: maskNumber(from), stage: 'empty', language: result.language });
    await send(localized('emptyVoiceNote', result.language));
    return { stage: 'empty' };
  }

  let spoke = false;
  if (result.audio) {
    try {
      await sendWhatsAppAudio(from, result.audio.buffer, { mimeType: result.audio.mimeType, filename: result.audio.filename, phoneNumberId });
      spoke = true;
    } catch (err) {
      // The words still go. A voice note that failed to upload is a text
      // reply, not a dropped question.
      console.warn(`Travel voice: could not send the voice reply to ${maskNumber(from)}: ${err.message}`);
    }
  }
  if (!spoke || textToo()) {
    await send(result.reply || localized('answerFailed', result.language));
  }

  recordTurnLog({
    channel: 'whatsapp',
    from: maskNumber(from),
    stage: 'answered',
    language: result.language,
    languageSource: result.languageSource,
    voice: Boolean(audio),
    spoke,
    transcript: result.transcript.slice(0, PREVIEW_CHARS),
    reply: (result.reply || '').slice(0, PREVIEW_CHARS),
    toolCalls: result.toolCalls.map((t) => t.name),
    providers: result.providers,
    timings: result.timings,
    // Only recorded when something was actually wrong with the answer, so a
    // scan down the log shows the bad turns rather than a column of nulls.
    ...(result.drift ? { drift: result.drift } : {}),
    ...(result.tooLong ? { words: result.words } : {}),
    costUsd: result.costUsd,
    durationMs: Date.now() - startedAt,
  });
  return { stage: 'answered', spoke, language: result.language };
}

/** A call event on the advisor's number — see calls.js for what happens. */
export async function handleTravelVoiceCall(event, { phoneNumberId }) {
  return handleCallEvent(event, {
    phoneNumberId,
    onDeclined: async (declined) => {
      const language = rememberedLanguage(`whatsapp-${normalizeNumber(declined.from)}`) || DEFAULT_LANGUAGE;
      await sendWhatsAppMessage(declined.from, localized('liveCallUnavailable', language), { phoneNumberId }).catch((err) =>
        console.warn(`Travel voice: could not explain the declined call: ${err.message}`)
      );
    },
  });
}

/**
 * Reaches out first. Sends a call-permission request, an introduction in
 * the chosen language and — when a message is given — that message spoken
 * as a voice note. If the number already granted permission and a media
 * bridge exists, places the call.
 *
 * @returns {Promise<{ permissionRequested: boolean, spoke: boolean, called: boolean, callId: string|null }>}
 */
export async function startTravelVoiceOutreach(to, { phoneNumberId, language = DEFAULT_LANGUAGE, message = '' }) {
  const lang = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  const number = normalizeNumber(to);
  if (!number) throw new Error('A phone number is required');
  if (!isTravelVoiceCallerAllowed(number)) throw new Error('That number is outside TRAVEL_VOICE_ALLOWED_NUMBERS');
  const sessionId = `whatsapp-${number}`;
  rememberLanguage(sessionId, lang);

  const outcome = { permissionRequested: false, spoke: false, called: false, callId: null };

  await sendWhatsAppMessage(number, localized('callPermissionIntro', lang), { phoneNumberId });
  await requestCallPermission(number, { phoneNumberId });
  outcome.permissionRequested = true;

  const spoken = String(message || '').trim();
  if (spoken && canSpeak()) {
    // The founder wrote this one. Their words go out whole, however long.
    const speech = await synthesizeSpeech(speakable(spoken, { maxWords: Infinity }), { language: lang, format: 'opus' });
    await sendWhatsAppAudio(number, speech.buffer, { mimeType: speech.mimeType, filename: speech.filename, phoneNumberId });
    outcome.spoke = true;
  } else if (spoken) {
    await sendWhatsAppMessage(number, spoken, { phoneNumberId });
  }

  if (hasCallPermission(number) && hasMediaBridge()) {
    const { callId } = await startCall(number, { phoneNumberId, context: { language: lang } });
    outcome.called = true;
    outcome.callId = callId;
  }

  recordTurnLog({ channel: 'whatsapp', from: maskNumber(number), stage: 'outreach', language: lang, spoke: outcome.spoke, called: outcome.called });
  return outcome;
}

// --- the venture record -----------------------------------------------------

/**
 * Registers the advisor as a venture in the portfolio, once. The rest of the
 * company reads ventures out of that list — the CFO reports against its
 * milestones, the Sales Manager looks for customers for it — so a product
 * that is not on it is invisible to the team that is meant to sell it.
 */
export function ensureTravelVoiceVenture() {
  const existing = listVentures().find((v) => v.title === VENTURE_TITLE);
  if (existing) return { venture: existing, created: false };

  const venture = createVenture({
    title: VENTURE_TITLE,
    oneLiner: 'A voice-to-voice Amadeus and travel-industry helpdesk on WhatsApp, in Spanish, French and English.',
    problem:
      'Travel agencies and corporate bookers lose hours a week to Amadeus questions — an entry that will not price, a fare rule nobody can read, a refund a client is shouting about. Helpdesks queue for twenty minutes and answer in one language; the experienced colleague who used to know is gone.',
    targetCustomer:
      'Independent travel agencies, home-based agents and small tour operators in Spain, France, Latin America, francophone Africa and the UK who work in Amadeus daily and have no in-house GDS trainer.',
    businessModel:
      'Per-agency monthly subscription with a per-seat tier, sold to agency owners; a free tier of a few questions a month to get agents talking to it.',
    marketSize:
      'Amadeus serves tens of thousands of agency locations across Europe and Latin America; every one of them has the problem on a busy day.',
    pathToMillions:
      'Land agency owners in Spain and France through voice-note demos, then follow Amadeus into the markets where it is the dominant GDS: Latin America, francophone Africa and the Middle East.',
    agentNativeEdge:
      'A human helpdesk cannot be fluent in three languages, awake at every hour and priced per question. An agent is all three from the first day, and it gets better from every question it answers.',
    milestones: [
      'First ten real voice-note conversations answered in the caller\'s language',
      'First agency owner using it daily for a week',
      'First paying agency',
      'Live WhatsApp calls, not only voice notes',
    ],
  });
  return { venture, created: true };
}

// --- status -----------------------------------------------------------------

export function travelVoiceStatus() {
  const capabilities = travelVoiceCapabilities();
  const venture = listVentures().find((v) => v.title === VENTURE_TITLE) || null;
  return {
    capabilities,
    languages: SUPPORTED_LANGUAGES,
    model: advisorModel(),
    voice: capabilities.speak ? { provider: resolveProvider('tts').id, model: ttsModel(), voice: ttsVoice() } : null,
    providers: describeProviders(),
    amadeus: capabilities.liveFares ? { environment: amadeusEnvironment() } : null,
    whatsapp: {
      phoneNumberId: travelVoicePhoneNumberId() || null,
      open: allowedCallers().length === 0,
      allowedCallers: allowedCallers().length,
      maxTurnsPerHour: maxTurnsPerHour(),
      liveCalls: capabilities.liveCalls,
    },
    venture: venture ? { id: venture.id, title: venture.title, status: venture.status } : null,
    recentTurns: recentTravelVoiceTurns(20),
    recentCalls: recentCallEvents(10),
  };
}

export function __resetTravelVoiceForTests() {
  turnsByCaller.clear();
  writeJson(STATE_FILE, { languages: {}, advisorMode: {}, log: [] });
}
