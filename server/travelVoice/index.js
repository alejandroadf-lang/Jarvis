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
import { loadSessions, saveSession, deleteSession, trimHistory } from '../sessionStore.js';
import { createVenture, listVentures } from '../finance/ventures.js';
import {
  downloadMedia,
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  sendWhatsAppPayload,
  normalizeNumber,
} from '../channels/whatsapp.js';
import { runAdvisorTurn, advisorModel } from './advisor.js';
import { transcribeWithLanguage, synthesizeSpeech, speakable, isSpeechConfigured, canHear, canSpeak, ttsModel, ttsVoice } from './speech.js';
import { isAmadeusConfigured, amadeusEnvironment } from './amadeus.js';
import { describeProviders, hasProvider, resolveProvider } from './providers/index.js';
import { checkReply } from './replyCheck.js';
import { readBack } from './spoken.js';
import { oggOpusDurationSeconds } from './ogg.js';
import { residencyMode } from './residency.js';
import {
  caseFor,
  rememberTurn,
  summarizeCase,
  forgetCase,
  sweepCases,
  contextPrompt,
  describeCase,
} from './context.js';
import { describeAnthropicGateway } from '../agents/anthropicClient.js';
import {
  consentMode,
  needsDisclosure,
  recordDisclosure,
  recordConsent,
  forgetConsent,
  voiceAllowed,
  listConsents,
  disclosurePayload,
  spokenDisclosure,
  consentAnswer,
  parseConsentReply,
  isForgetRequest,
  consentState,
} from './consent.js';
import {
  recordAudit,
  callerKey,
  maybeSample,
  sessionUnderCap,
  sessionCapUsd,
  recordSessionSpend,
  sweepRetention,
  metrics as auditMetrics,
  reviewQueue,
  markReviewed,
  retentionDays,
} from './audit.js';
import {
  escalationNumbers,
  isHandoffRequest,
  isEscalated,
  openHandoff,
  openHandoffFor,
  recordForwarded,
  recordSaid,
  closeHandoff,
  listOpenHandoffs,
  recentHandoffEvents,
  handoffText,
  notificationFor,
} from './escalation.js';
import { assertUnderDailyCap, recordSpend } from '../spend.js';
import { priceUsage } from '../usage.js';
import {
  resolveLanguage,
  requestedLanguageSwitch,
  normalizeLanguage,
  languageFromNumber,
  guessLanguage,
  localized,
  isBareGreeting,
  LANGUAGE_NAMES,
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
import { isGuest, addGuest, listGuests } from './guests.js';
import { override as settingOverride } from './settings.js';
import { parseTravelCommand, runTravelCommand } from './commands.js';
import {
  modeFor,
  setMode,
  clearMode,
  targetFor,
  describeMode,
  runTranslation,
  droppedCodes,
  parseTranslateCommand,
  replyFor,
} from './translate.js';

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

/** Below this many seconds of audio, a clip cannot change the conversation's language. */
export function shortClipSeconds() {
  const value = Number(process.env.TRAVEL_VOICE_SHORT_CLIP_SECONDS);
  return Number.isFinite(value) && value >= 0 ? value : 2;
}

export function maxTurnsPerHour() {
  const pinned = settingOverride('limit');
  if (pinned !== undefined) return pinned;
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
  const data = readJson(STATE_FILE, { languages: {}, advisorMode: {}, log: [], lastSeen: {} });
  if (!data.languages) data.languages = {};
  if (!data.advisorMode) data.advisorMode = {};
  if (!Array.isArray(data.log)) data.log = [];
  if (!data.lastSeen) data.lastSeen = {};
  return data;
}

function saveState(data) {
  writeJson(STATE_FILE, data);
}

function rememberLanguage(sessionId, language) {
  const data = loadState();
  data.languages[sessionId] = language;
  // When this conversation was last alive: the clock the retention sweep
  // reads. A conversation nobody has touched in six months is forgotten.
  data.lastSeen[sessionId] = new Date().toISOString();
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

// What every log line carries about the caller: the masked number for the
// founder's eye, the salted hash for the audit trail, and the consent
// state at the moment of the turn — so the trail can show that a voice
// note was processed only after the tap, not merely that a tap exists.
function turnMeta(number) {
  const state = consentState(number);
  return {
    caller: callerKey(number),
    from: maskNumber(number),
    consent: state?.consent || null,
    disclosed: Boolean(state?.disclosedAt),
  };
}

function recordTurnLog(entry) {
  const at = new Date().toISOString();
  try {
    const data = loadState();
    data.log.push({ at, ...entry });
    if (data.log.length > MAX_LOG) data.log = data.log.slice(-MAX_LOG);
    saveState(data);
  } catch (err) {
    console.error('Travel voice: could not record a turn:', err.message);
  }
  // The trail keeps everything but the words, for years; the log above
  // keeps the last hundred with a preview, for the founder's phone.
  recordAudit({ at, kind: 'turn', ...entry });
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
  fallbackLanguage = null,
  wantAudio = false,
  providers = {},
}) {
  const startedAt = Date.now();
  // A language pinned from a phone behaves exactly like a caller who chose
  // one: it beats detection, which is the point when you are demonstrating
  // to a French agency and do not want a stray English word to decide.
  const chosen = language || settingOverride('language') || null;
  // What the conversation was in last time; for a first message, whatever
  // the channel can say about the caller (their country code) rather than
  // English by reflex.
  const previous = rememberedLanguage(sessionId) || normalizeLanguage(fallbackLanguage) || null;
  let transcript = String(text || '').trim();
  let heard = null;
  let costUsd = 0;
  let durationSeconds = null;
  let shortClip = false;
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
      languageHint: normalizeLanguage(chosen) || previous,
      provider: providers.stt,
    });
    transcript = result.text;
    heard = result.language;
    costUsd += result.costUsd;
    used.stt = result.provider;
    timings.sttMs = result.ms;
    durationSeconds = result.durationSeconds ?? oggOpusDurationSeconds(audio);
    // Language identification is unreliable under about two seconds of
    // speech — "oui", "vale", "ok merci" — and a conversation almost never
    // changes language on a clip that short without saying so. So a short
    // clip cannot switch a conversation that already has a language; what
    // the transcriber heard is kept as evidence but not acted on.
    shortClip = Number.isFinite(durationSeconds) && durationSeconds < shortClipSeconds();
    if (shortClip && previous && heard && heard !== previous) heard = null;
    if (!transcript) {
      // The transcriber may still have heard which language the silence was in.
      return {
        transcript: '',
        language: normalizeLanguage(chosen) || heard || previous || DEFAULT_LANGUAGE,
        empty: true,
        costUsd,
        providers: used,
        timings,
      };
    }
  }

  const switched = requestedLanguageSwitch(transcript);
  const resolved = shortClip && previous && !switched && !chosen
    ? { language: previous, source: 'previous' }
    : resolveLanguage({ chosen: switched || chosen, heard, text: transcript, previous });
  const history = sessionHistory(sessionId);
  // What survived the last trim: the locators in play, the carriers, what
  // has already been suggested. Free to read and free to carry.
  const known = caseFor(sessionId);
  // A locator or ticket number heard in a voice note is read back before
  // the answer, spelled in the caller's alphabet, so the one person who can
  // catch a misheard letter gets the chance. A typed one needs no reading
  // back: they can see what they typed.
  const heardBack = audio ? readBack(transcript, resolved.language) : null;

  const turn = await runAdvisorTurn({
    anthropic,
    provider: providers.llm,
    history,
    text: transcript,
    language: resolved.language,
    context: contextPrompt(known),
  });
  costUsd += turn.usage.costUsd;
  used.llm = turn.provider;
  timings.llmMs = turn.ms;
  // Whether the brain answered in the language it was told to, and how long
  // it ran on. Carried out of the turn because it is the evidence behind
  // "this model cannot be trusted on a Spanish line" — see replyCheck.js.
  const quality = { drift: turn.drift, grounding: turn.grounding, amounts: turn.amounts, handoff: turn.handoff, promptVersion: turn.promptVersion, words: turn.words, tooLong: turn.tooLong };

  const trimmed = trimHistory(turn.messages);
  saveSession(SESSION_KIND, sessionId, trimmed);
  rememberLanguage(sessionId, resolved.language);

  // The case, updated from what was just said. The facts cost nothing; the
  // note is rewritten only when the trim actually dropped messages, which
  // is the one moment something would otherwise be lost for good.
  rememberTurn(sessionId, { text: transcript, reply: turn.reply, language: resolved.language });
  const dropped = turn.messages.length - trimmed.length;
  if (dropped > 0) {
    await summarizeCase(sessionId, {
      anthropic,
      brain: resolveProvider('llm', providers.llm),
      history: turn.messages,
      previous: known?.summary || null,
      through: turn.messages.length,
    });
  }

  let speech = null;
  let audioError = null;
  if (wantAudio && turn.reply) {
    try {
      const spokenReply = heardBack ? `${heardBack.spoken} ${turn.reply}` : turn.reply;
      speech = await synthesizeSpeech(speakable(spokenReply, { language: resolved.language }), { language: resolved.language, format: 'opus', provider: providers.tts });
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
    readBack: heardBack,
    durationSeconds,
    shortClip,
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

/**
 * One translation turn: hear it, render it in the other language, say it back.
 *
 * Shares the ears and the voice with the advisor and differs only in the
 * middle. The language resolution is the opposite way round from an advisor
 * turn: there, what the caller spoke decides what they hear back; here it
 * decides what they must NOT hear back.
 */
export async function runTranslateTurn({
  anthropic,
  sessionId,
  text = '',
  audio = null,
  filename = 'voice.ogg',
  wantAudio = false,
  providers = {},
  mode,
}) {
  const startedAt = Date.now();
  let transcript = String(text || '').trim();
  let heard = null;
  let costUsd = 0;
  const used = { stt: null, llm: null, tts: null };
  const timings = { sttMs: null, llmMs: null, ttsMs: null };

  if (audio) {
    // No language hint: in a translation the source is the thing being
    // detected, and telling the transcriber what to expect would let a
    // French sentence be decoded as bad Spanish.
    const result = await transcribeWithLanguage(audio, { filename, provider: providers.stt });
    transcript = result.text;
    heard = result.language;
    costUsd += result.costUsd;
    used.stt = result.provider;
    timings.sttMs = result.ms;
    if (!transcript) {
      return { transcript: '', empty: true, costUsd, providers: used, timings, mode };
    }
  }

  // Text with no audio still needs a source, so the pair knows which way to
  // go. The word heuristic is enough: a pair only has to pick between two.
  if (!heard) heard = resolveLanguage({ text: transcript }).language;
  const target = targetFor(mode, heard);

  const brain = resolveProvider('llm', providers.llm);
  if (!brain) throw new Error('No advisor model is configured — set ANTHROPIC_API_KEY');
  assertUnderDailyCap();
  const done = await runTranslation({ anthropic, brain, text: transcript, target, source: heard });
  const cost = priceUsage(
    {
      inputTokens: done.usage.input_tokens || 0,
      outputTokens: done.usage.output_tokens || 0,
      cacheWriteTokens: done.usage.cache_creation_input_tokens || 0,
      cacheReadTokens: done.usage.cache_read_input_tokens || 0,
    },
    brain.priceSpec()
  );
  recordSpend(cost);
  costUsd += cost;
  used.llm = done.provider;
  timings.llmMs = done.ms;

  // Did every locator, code and price survive? Reported, never repaired:
  // putting a locator back into a sentence the model did not write it into
  // would place it wrongly, and a locator in the wrong place reads as right.
  const dropped = droppedCodes(transcript, done.text);
  // The same drift guard the advisor uses, pointed at the target language.
  const check = checkReply(done.text, { language: target });

  let speech = null;
  let audioError = null;
  if (wantAudio && done.text) {
    try {
      speech = await synthesizeSpeech(speakable(done.text, { language: target }), { language: target, format: 'opus', provider: providers.tts });
      costUsd += speech.costUsd;
      used.tts = speech.provider;
      timings.ttsMs = speech.ms;
    } catch (err) {
      audioError = err.message;
    }
  }

  return {
    transcript,
    source: heard,
    language: target,
    reply: done.text,
    translated: true,
    dropped,
    protectedCodes: done.protectedCodes,
    pivot: done.pivot,
    tooLong: check.tooLong,
    words: check.words,
    audio: speech ? { buffer: speech.buffer, mimeType: speech.mimeType, filename: speech.filename } : null,
    audioError,
    model: done.model,
    costUsd,
    providers: used,
    timings,
    mode,
    durationMs: Date.now() - startedAt,
  };
}

export function resetTravelVoiceSession(sessionId) {
  saveSession(SESSION_KIND, sessionId, []);
  // The case goes with the transcript, always. It is the same conversation
  // by another name, and a "forget me" that left it behind would leave the
  // locators — the most identifying thing here — sitting in a file.
  forgetCase(sessionId);
  const data = loadState();
  delete data.languages[sessionId];
  delete data.lastSeen[sessionId];
  saveState(data);
}

// --- WhatsApp ---------------------------------------------------------------

function isVoiceNote(message) {
  return message.type === 'audio' || message.type === 'voice';
}

function textToo() {
  const pinned = settingOverride('text');
  if (pinned !== undefined) return pinned;
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
  // The language for anything said before the advisor has answered — the
  // notice, a rate-limit message, an apology. A returning caller has one on
  // record; a new one who typed is guessed from their words; a new one who
  // spoke cannot be listened to before they have been told what this is,
  // so their country code decides, and English is the last resort.
  const typedGuess = message.text?.trim() ? guessLanguage(message.text) : null;
  const previous =
    rememberedLanguage(sessionId) ||
    (typedGuess?.language && typedGuess.confidence >= 0.6 ? typedGuess.language : null) ||
    languageFromNumber(from) ||
    DEFAULT_LANGUAGE;
  const startedAt = Date.now();

  // A tap on one of the consent buttons. Recorded with Meta's id for the
  // tap, which is the evidence that this person agreed, and when.
  const tapped = parseConsentReply(message.buttonReply);
  if (tapped) {
    recordConsent(from, { granted: tapped.granted, messageId: message.id, buttonId: message.buttonReply.id });
    recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'consent', language: previous, detail: tapped.granted ? 'granted' : 'declined' });
    await send(consentAnswer(tapped.granted ? 'granted' : 'declined', previous));
    return { stage: 'consent', granted: tapped.granted };
  }

  if (!admitTurn(sessionId)) {
    recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'rate_limited', language: previous });
    await send(localized('rateLimited', previous));
    return { stage: 'rate_limited' };
  }

  // "BORRAR" / "SUPPRIMER" / "DELETE": the caller withdraws and is forgotten
  // — consent, history, language, translation mode — from this line.
  if (!isVoiceNote(message) && isForgetRequest(message.text)) {
    forgetConsent(from);
    resetTravelVoiceSession(sessionId);
    clearMode(sessionId);
    recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'forgotten', language: previous });
    await send(consentAnswer('forgotten', previous));
    return { stage: 'forgotten' };
  }

  // First contact: say what this is before doing anything with what they
  // sent. Spoken in the advisor's voice and written with the two buttons.
  const firstContact = needsDisclosure(from);
  if (firstContact) await discloseTo(from, { language: previous, phoneNumberId });

  // Voice waits for the tap. Nothing is downloaded, let alone transcribed,
  // until it has been given; text is answered meanwhile.
  if (isVoiceNote(message) && !voiceAllowed(from)) {
    if (!firstContact) await send(consentAnswer('needed', previous));
    recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'consent_required', language: previous });
    return { stage: 'consent_required' };
  }

  let audio = null;
  let filename = 'voice.ogg';
  if (isVoiceNote(message) && message.mediaId) {
    if (!canHear()) {
      recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'unsupported_type', language: previous, detail: 'voice note with no speech-to-text provider configured' });
      await send(localized('unsupportedType', previous));
      return { stage: 'unsupported_type' };
    }
    try {
      const media = await downloadMedia(message.mediaId);
      audio = media.buffer;
      filename = media.filename;
    } catch (err) {
      recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'failed', language: previous, detail: err.message });
      await send(localized('transcriptionFailed', previous));
      return { stage: 'failed', error: err.message };
    }
  } else if (!message.text?.trim()) {
    recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'unsupported_type', language: previous, detail: `type: ${message.type}` });
    await send(localized('unsupportedType', previous));
    return { stage: 'unsupported_type' };
  }

  // A person is in charge of this conversation. Nothing goes to a model;
  // what the caller sent goes to the people on the escalation list, and
  // the caller is told it arrived. A voice note is transcribed so a person
  // can read it — they may be in a meeting — and that is all.
  if (isEscalated(from)) {
    let said = message.text?.trim() || '';
    let voice = false;
    if (audio) {
      voice = true;
      try {
        const heard = await transcribeWithLanguage(audio, { filename, languageHint: previous });
        said = heard.text;
      } catch (err) {
        said = `(voice note, could not be transcribed: ${err.message})`;
      }
    }
    recordForwarded(from, { text: said, voice });
    await notifyEscalation(`Caller +${normalizeNumber(from)}${voice ? ' (voice note)' : ''}: ${said || '(empty)'}`, { phoneNumberId });
    recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'handoff_forwarded', language: previous, voice, transcript: said.slice(0, PREVIEW_CHARS) });
    await send(handoffText('waiting', previous));
    return { stage: 'handoff_forwarded' };
  }

  // The caller asks for a person, in so many words. Decided here, before
  // any model, so nobody has to argue with the machine to reach a human.
  if (!audio && isHandoffRequest(message.text)) {
    await openHandoffAndTell(from, { by: 'caller', reason: 'The caller asked for a person.', language: previous, transcript: message.text, phoneNumberId, send });
    return { stage: 'handoff_opened', by: 'caller' };
  }

  // TRANSLATE / TRADUCIR / TRADUIRE. Caller-facing on purpose: this is a
  // feature of the product, not an admin control. It changes this one
  // conversation and reaches nothing else, so a guest running it is exactly
  // as safe as a guest asking a question. Checked before the greeting so
  // "TRADUIRE OFF" works even from a caller who has said nothing else.
  if (!audio) {
    const command = parseTranslateCommand(message.text);
    if (command) {
      const lang = rememberedLanguage(sessionId) || previous;
      let reply;
      if (command.kind === 'off') {
        clearMode(sessionId);
        reply = replyFor('off', lang);
      } else if (command.kind === 'status') {
        const current = modeFor(sessionId);
        reply = current
          ? replyFor(current.to ? 'on_to' : 'on_pair', lang, describeMode(current).replace(/^into /, ''))
          : replyFor('status_off', lang);
      } else if (command.kind === 'same') {
        reply = replyFor('same', lang);
      } else if (command.kind === 'to') {
        setMode(sessionId, { to: command.to });
        reply = replyFor('on_to', lang, LANGUAGE_NAMES[command.to].native);
      } else {
        setMode(sessionId, { pair: command.pair });
        reply = replyFor('on_pair', lang, command.pair.map((l) => LANGUAGE_NAMES[l].native).join(' ↔ '));
      }
      recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'translate_mode', language: lang, detail: command.kind });
      await send(reply);
      return { stage: 'translate_mode', mode: command.kind };
    }
  }

  // One conversation may not spend more than its share of a day. The daily
  // cap protects the bill from everyone at once; this protects it from one
  // caller who found the number, and tells them so rather than going quiet.
  if (!sessionUnderCap(sessionId)) {
    recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'session_cap', language: previous, capUsd: sessionCapUsd() });
    await send(localized('sessionCapReached', previous));
    return { stage: 'session_cap' };
  }

  // In translation mode the advisor steps aside entirely. An advisor that
  // helpfully answers the question inside a sentence it was asked to
  // translate has destroyed the thing it was handed.
  const translating = modeFor(sessionId);
  if (translating) {
    let out;
    try {
      out = await runTranslateTurn({
        anthropic,
        sessionId,
        text: audio ? '' : message.text,
        audio,
        filename,
        wantAudio: Boolean(audio) && canSpeak(),
        mode: translating,
      });
    } catch (err) {
      recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'failed', language: previous, detail: `translate: ${err.message}` });
      await send(localized('answerFailed', previous));
      return { stage: 'failed', error: err.message };
    }
    if (out.empty) {
      await send(localized('emptyVoiceNote', previous));
      return { stage: 'empty' };
    }

    let spoke = false;
    if (out.audio) {
      try {
        await sendWhatsAppAudio(from, out.audio.buffer, { mimeType: out.audio.mimeType, filename: out.audio.filename, phoneNumberId });
        spoke = true;
      } catch (err) {
        console.warn(`Travel voice: could not send the translation to ${maskNumber(from)}: ${err.message}`);
      }
    }
    // The text always goes, whatever TRAVEL TEXT says. A translation is
    // meant to be forwarded, and you cannot forward a sentence you only
    // heard — which is the entire point of translating it.
    await send(out.reply);
    if (out.dropped.length) {
      await send(`⚠ Check these before you send it on: ${out.dropped.join(', ')}. They were in what you said and are not in the translation.`);
    }

    recordSessionSpend(sessionId, out.costUsd);
    recordTurnLog({
      channel: 'whatsapp',
      ...turnMeta(from),
      stage: 'translated',
      language: out.language,
      source: out.source,
      voice: Boolean(audio),
      spoke,
      transcript: out.transcript.slice(0, PREVIEW_CHARS),
      reply: out.reply.slice(0, PREVIEW_CHARS),
      providers: out.providers,
      timings: out.timings,
      ...(out.dropped.length ? { dropped: out.dropped } : {}),
      ...(out.pivot ? { pivot: true } : {}),
      costUsd: out.costUsd,
      durationMs: Date.now() - startedAt,
    });
    return { stage: 'translated', spoke, language: out.language, source: out.source };
  }

  // Somebody who has just been handed the number and typed "hola". A fixed
  // greeting says what this is and what to send next, better than a model
  // call would and for nothing. Only a message that is *nothing but* a
  // hello, so a real question that opens politely still reaches the advisor.
  if (!audio && isBareGreeting(message.text)) {
    const lang = resolveLanguage({ text: message.text, previous: rememberedLanguage(sessionId) }).language;
    rememberLanguage(sessionId, lang);
    recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'greeted', language: lang });
    await send(localized('greeting', lang));
    return { stage: 'greeted', language: lang };
  }

  let result;
  try {
    result = await runTravelVoiceTurn({
      anthropic,
      sessionId,
      text: audio ? '' : message.text,
      audio,
      filename,
      fallbackLanguage: languageFromNumber(from),
      wantAudio: Boolean(audio) && canSpeak(),
    });
  } catch (err) {
    recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'failed', language: previous, detail: err.message, durationMs: Date.now() - startedAt });
    await send(localized('answerFailed', previous));
    return { stage: 'failed', error: err.message };
  }

  if (result.empty) {
    recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'empty', language: result.language });
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
    // The written twin: the answer with every code exactly as the model
    // wrote it, and above it what was heard, so a wrong locator is visible
    // as well as audible.
    const written = result.reply || localized('answerFailed', result.language);
    await send(result.readBack ? `${result.readBack.written}\n\n${written}` : written);
  }

  // The advisor asked for a person, or the voice note did. The answer has
  // gone out; the handoff opens on top of it.
  const handoff = result.handoff || (audio && isHandoffRequest(result.transcript) ? { reason: 'The caller asked for a person.' } : null);
  if (handoff) {
    await openHandoffAndTell(from, {
      by: result.handoff ? 'advisor' : 'caller',
      reason: handoff.reason,
      language: result.language,
      transcript: result.transcript,
      phoneNumberId,
      send,
    });
  }

  recordSessionSpend(sessionId, result.costUsd);
  // A few per cent of answered turns, words included, for a person to read.
  maybeSample({
    from,
    language: result.language,
    voice: Boolean(audio),
    providers: result.providers,
    model: result.model,
    transcript: result.transcript,
    reply: result.reply,
    flags: {
      ...(result.drift ? { drift: result.drift } : {}),
      ...(result.grounding ? { grounding: result.grounding } : {}),
      ...(result.readBack ? { readBack: result.readBack.codes } : {}),
      ...(result.shortClip ? { shortClip: true } : {}),
      ...(handoff ? { handoff: handoff.reason } : {}),
    },
  });
  recordTurnLog({
    channel: 'whatsapp',
    ...turnMeta(from),
    stage: 'answered',
    language: result.language,
    languageSource: result.languageSource,
    voice: Boolean(audio),
    spoke,
    transcript: result.transcript.slice(0, PREVIEW_CHARS),
    reply: (result.reply || '').slice(0, PREVIEW_CHARS),
    toolCalls: result.toolCalls.map((t) => t.name),
    providers: result.providers,
    model: result.model,
    promptVersion: result.promptVersion,
    timings: result.timings,
    ...(result.readBack ? { readBack: result.readBack.codes } : {}),
    ...(result.shortClip ? { shortClip: true, durationSeconds: result.durationSeconds } : {}),
    // Only recorded when something was actually wrong with the answer, so a
    // scan down the log shows the bad turns rather than a column of nulls.
    ...(result.drift ? { drift: result.drift } : {}),
    ...(result.grounding ? { grounding: result.grounding } : {}),
    ...(handoff ? { handoff: handoff.reason } : {}),
    ...(result.tooLong ? { words: result.words } : {}),
    costUsd: result.costUsd,
    durationMs: Date.now() - startedAt,
  });
  return { stage: 'answered', spoke, language: result.language, ...(handoff ? { handoff: true } : {}) };
}

// --- a person -------------------------------------------------------------------

/** Sends a line to everyone on the escalation list; a failure is logged, not thrown. */
async function notifyEscalation(text, { phoneNumberId = null } = {}) {
  const targets = escalationNumbers();
  const sender = process.env.WHATSAPP_PHONE_NUMBER_ID || phoneNumberId;
  const reached = [];
  for (const number of targets) {
    try {
      await sendWhatsAppMessage(number, text, { phoneNumberId: sender });
      reached.push(number);
    } catch (err) {
      console.warn(`Travel voice: could not reach ${maskNumber(number)} for a handoff: ${err.message}`);
    }
  }
  if (!targets.length) console.warn('Travel voice: a handoff opened but TRAVEL_VOICE_ESCALATION_NUMBERS and WHATSAPP_ALLOWED_NUMBERS are both empty — nobody was told.');
  return reached;
}

/**
 * Opens the handoff, tells the people who can take it, and tells the
 * caller. The caller hears it in their language; the people on the list
 * get the number itself, because they need to be able to ring it.
 */
async function openHandoffAndTell(from, { by, reason, language, transcript, phoneNumberId, send }) {
  const entry = openHandoffFor(from, { by, reason, language, transcript });
  // The person taking over gets the case, not just the last message. That
  // is the difference between picking up a conversation and starting one.
  const known = caseFor(`whatsapp-${normalizeNumber(from)}`);
  const note = known ? `\n\nThe case so far:\n${describeCase(known)}` : '';
  const reached = await notifyEscalation(`${notificationFor(entry, { from })}${note}`, { phoneNumberId });
  recordTurnLog({ channel: 'whatsapp', ...turnMeta(from), stage: 'handoff_opened', language, detail: `${by}: ${reason || ''}`.trim(), notified: reached.length });
  await send(handoffText('opened', language));
  return { entry, reached };
}

/** A person answers through the advisor's number. The override, logged. */
export async function sayAsHuman(number, text, { by, phoneNumberId = null } = {}) {
  const digits = normalizeNumber(number);
  if (!digits) throw new Error('A phone number is required');
  const words = String(text || '').trim();
  if (!words) throw new Error('Nothing to say');
  const from = travelVoicePhoneNumberId() || phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  await sendWhatsAppMessage(digits, words, { phoneNumberId: from });
  // Saying something to a caller takes the conversation over if it was not
  // already: a person who answers is a person in charge.
  if (!isEscalated(digits)) openHandoffFor(digits, { by: 'founder', reason: 'A person answered.', language: rememberedLanguage(`whatsapp-${digits}`) });
  recordSaid(digits, { text: words, by });
  recordTurnLog({ channel: 'whatsapp', ...turnMeta(digits), stage: 'handoff_said', language: rememberedLanguage(`whatsapp-${digits}`), reply: words.slice(0, PREVIEW_CHARS) });
  return { number: digits };
}

/** A person takes a conversation without waiting to be asked. */
export async function takeOver(number, { by, reason = 'Taken by a person.', phoneNumberId = null } = {}) {
  const digits = normalizeNumber(number);
  if (!digits) throw new Error('A phone number is required');
  const language = rememberedLanguage(`whatsapp-${digits}`) || languageFromNumber(digits) || DEFAULT_LANGUAGE;
  const from = travelVoicePhoneNumberId() || phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const entry = openHandoffFor(digits, { by: 'founder', reason, language });
  recordTurnLog({ channel: 'whatsapp', ...turnMeta(digits), stage: 'handoff_opened', language, detail: `founder: ${reason}` });
  await sendWhatsAppMessage(digits, handoffText('opened', language), { phoneNumberId: from }).catch((err) =>
    console.warn(`Travel voice: could not tell ${maskNumber(digits)} a person took over: ${err.message}`)
  );
  return entry;
}

/** Hands a conversation back to the advisor and tells the caller. */
export async function resumeAdvisor(number, { by, phoneNumberId = null } = {}) {
  const digits = normalizeNumber(number);
  const closed = closeHandoff(digits, { by });
  if (!closed) return null;
  const language = closed.language || rememberedLanguage(`whatsapp-${digits}`) || DEFAULT_LANGUAGE;
  const from = travelVoicePhoneNumberId() || phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  recordTurnLog({ channel: 'whatsapp', ...turnMeta(digits), stage: 'handoff_resumed', language });
  await sendWhatsAppMessage(digits, handoffText('resumed', language), { phoneNumberId: from }).catch((err) =>
    console.warn(`Travel voice: could not tell ${maskNumber(digits)} the advisor is back: ${err.message}`)
  );
  return closed;
}

/**
 * The disclosure, delivered: spoken first when there is a voice, then the
 * written notice with its two buttons. Recorded with the id of the written
 * message. A failure to speak is not a failure to disclose — the text is
 * the record — but a failure to send the text is thrown, because a caller
 * who was never told must not be processed.
 */
export async function discloseTo(number, { language = DEFAULT_LANGUAGE, phoneNumberId = null, speak = true } = {}) {
  const lang = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  let spoke = false;
  if (speak && canSpeak()) {
    try {
      const speech = await synthesizeSpeech(speakable(spokenDisclosure(lang), { maxWords: Infinity }), { language: lang, format: 'opus' });
      await sendWhatsAppAudio(number, speech.buffer, { mimeType: speech.mimeType, filename: speech.filename, phoneNumberId });
      spoke = true;
    } catch (err) {
      console.warn(`Travel voice: could not speak the disclosure to ${maskNumber(number)}: ${err.message}`);
    }
  }
  const sent = await sendWhatsAppPayload(number, disclosurePayload(lang), { phoneNumberId });
  const messageId = sent?.messages?.[0]?.id || null;
  recordDisclosure(number, { language: lang, messageId, spoken: spoke });
  recordTurnLog({ channel: 'whatsapp', ...turnMeta(number), stage: 'disclosed', language: lang, spoke, detail: consentMode() });
  return { spoke, messageId };
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

  recordTurnLog({ channel: 'whatsapp', ...turnMeta(number), stage: 'outreach', language: lang, spoke: outcome.spoke, called: outcome.called });
  return outcome;
}

// --- running the demo from a phone ------------------------------------------

/**
 * Invites someone to try the advisor: puts them on the guest list and sends
 * a hello, as text and — this is the actual demo — as a voice note in the
 * product's own voice. An agency owner judges this thing on how it sounds
 * before they have read a word, so the first thing they get should be sound.
 */
export async function inviteGuest(number, { language = null, phoneNumberId = null } = {}) {
  const lang = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  const digits = addGuest(number, { language: lang });
  const from = phoneNumberId || travelVoicePhoneNumberId() || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!from) throw new Error('No WhatsApp number to send from');

  // The guest list is already updated above, and that is the half that
  // matters: they can message the number from this moment whether or not the
  // hello reaches them. So a failed send is reported, not thrown — throwing
  // would tell the founder nothing happened when in fact the invitation is
  // live, and they would invite the same person twice.
  const greeting = localized('greeting', lang);
  let delivered = true;
  let error = null;
  try {
    await sendWhatsAppMessage(digits, greeting, { phoneNumberId: from });
  } catch (err) {
    delivered = false;
    error = err.message;
  }

  let spoke = false;
  if (delivered && canSpeak()) {
    try {
      // The greeting is short and deliberately written; it is not the
      // advisor rambling, so it goes out whole — with the spoken disclosure
      // on the end of it, so the first thing they hear says what this is.
      const words = consentMode() === 'off' ? greeting : `${greeting} ${spokenDisclosure(lang)}`;
      const speech = await synthesizeSpeech(speakable(words, { maxWords: Infinity }), { language: lang, format: 'opus' });
      await sendWhatsAppAudio(digits, speech.buffer, { mimeType: speech.mimeType, filename: speech.filename, phoneNumberId: from });
      spoke = true;
    } catch (err) {
      // They still have the text and can still write. A failed voice note is
      // a worse invitation, not a failed one.
      console.warn(`Travel voice: could not speak the invitation to ${maskNumber(digits)}: ${err.message}`);
    }
  }
  // The written notice and its buttons, so their first voice note is not
  // met with a second hello. Already spoken above, so not spoken again.
  if (delivered && needsDisclosure(digits)) {
    try {
      await discloseTo(digits, { language: lang, phoneNumberId: from, speak: false });
    } catch (err) {
      console.warn(`Travel voice: could not send the notice to ${maskNumber(digits)}: ${err.message}`);
    }
  }

  // So their first real message is answered in the language they were
  // invited in, before anything has been heard from them.
  rememberLanguage(`whatsapp-${digits}`, lang);
  recordTurnLog({ channel: 'whatsapp', ...turnMeta(digits), stage: 'invited', language: lang, spoke, detail: error || undefined });
  return { number: digits, language: lang, spoke, delivered, error };
}

export { parseTravelCommand, isGuest, listGuests };
export { parseTranslateCommand, modeFor as translateModeFor, setMode as setTranslateMode, clearMode as clearTranslateMode };

/**
 * Runs a TRAVEL command from the founder's own line. The dependencies are
 * bound here rather than in commands.js so that file reaches nothing on its
 * own and stays testable without a WhatsApp stub.
 */
export function runTravelVoiceCommand(command, { from, phoneNumberId = null } = {}) {
  return runTravelCommand(command, {
    setAdvisorMode: (on) => setAdvisorMode(from, on),
    recentTurns: recentTravelVoiceTurns,
    inviteGuest: (number, opts) => inviteGuest(number, { ...opts, phoneNumberId }),
    localized,
    maskNumber,
    metrics: (days) => auditMetrics({ days }),
    context: {
      show: (number) => describeCase(caseFor(`whatsapp-${normalizeNumber(number)}`)),
      forget: (number) => {
        const sessionId = `whatsapp-${normalizeNumber(number)}`;
        const had = Boolean(caseFor(sessionId));
        resetTravelVoiceSession(sessionId);
        clearMode(sessionId);
        return had;
      },
    },
    review: { queue: reviewQueue, mark: (id, verdict, note) => markReviewed(id, { verdict, note, by: from }) },
    sweep: () => runRetentionSweep(),
    handoffs: {
      list: listOpenHandoffs,
      recent: recentHandoffEvents,
      say: (number, text) => sayAsHuman(number, text, { by: from, phoneNumberId }),
      take: (number) => takeOver(number, { by: from, phoneNumberId }),
      resume: (number) => resumeAdvisor(number, { by: from, phoneNumberId }),
      numbers: escalationNumbers,
    },
  });
}

// --- retention, review and the numbers --------------------------------------------

/**
 * Forgets what is older than the retention period: the turn log's
 * previews, and every conversation nobody has touched since. The audit
 * trail and the review queue have their own clocks in audit.js.
 */
function sweepConversations(cutoffMs) {
  const data = loadState();
  const before = data.log.length;
  data.log = data.log.filter((entry) => Date.parse(entry.at) >= cutoffMs);
  let removed = before - data.log.length;
  const sessions = loadSessions(SESSION_KIND);
  for (const sessionId of sessions.keys()) {
    const seen = data.lastSeen[sessionId] ? Date.parse(data.lastSeen[sessionId]) : 0;
    if (seen >= cutoffMs) continue;
    deleteSession(SESSION_KIND, sessionId);
    delete data.languages[sessionId];
    delete data.lastSeen[sessionId];
    clearMode(sessionId);
    removed += 1;
  }
  saveState(data);
  return removed + sweepCases(cutoffMs);
}

/** Runs every retention clock now. Returns what was removed. */
export function runRetentionSweep({ now = Date.now() } = {}) {
  return sweepRetention({ now, sweepConversations });
}

let sweeper = null;

/** Sweeps on start and once a day after that. */
export function startRetentionSweeper() {
  if (sweeper) return sweeper;
  try {
    const removed = runRetentionSweep();
    console.log(`Travel voice: retention sweep — ${removed.conversations} conversations, ${removed.reviewItems} review items, ${removed.auditLines} audit lines removed (transcripts kept ${retentionDays()} days).`);
  } catch (err) {
    console.error('Travel voice: retention sweep failed:', err.message);
  }
  sweeper = setInterval(() => {
    try {
      runRetentionSweep();
    } catch (err) {
      console.error('Travel voice: retention sweep failed:', err.message);
    }
  }, 24 * 60 * 60 * 1000);
  if (typeof sweeper.unref === 'function') sweeper.unref();
  return sweeper;
}

export function travelVoiceMetrics({ days = 7 } = {}) {
  return auditMetrics({ days });
}

export { reviewQueue as travelVoiceReviewQueue, markReviewed as markTravelVoiceReviewed };

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
    translation: { available: true, languages: SUPPORTED_LANGUAGES },
    handoffs: { open: listOpenHandoffs().map((h) => ({ number: maskNumber(h.number), openedAt: h.openedAt, by: h.by, reason: h.reason, language: h.language })), notifies: escalationNumbers().length },
    residency: { mode: residencyMode(), anthropic: describeAnthropicGateway() },
    retention: { transcriptDays: retentionDays(), sessionCapUsd: sessionCapUsd() },
    consent: {
      mode: consentMode(),
      disclosed: listConsents(maskNumber).length,
      granted: listConsents(maskNumber).filter((c) => c.consent === 'granted').length,
    },
    guests: listGuests().map((g) => ({ number: maskNumber(g.number), language: g.language, addedAt: g.addedAt })),
    venture: venture ? { id: venture.id, title: venture.title, status: venture.status } : null,
    recentTurns: recentTravelVoiceTurns(20),
    recentCalls: recentCallEvents(10),
  };
}

export function __resetTravelVoiceForTests() {
  turnsByCaller.clear();
  writeJson(STATE_FILE, { languages: {}, advisorMode: {}, log: [] });
}
