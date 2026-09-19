// Ears: every speech-to-text provider the advisor can listen through.
//
// One contract, three implementations. A transcriber takes audio bytes and
// answers with the words, the language it heard (as one of the advisor's
// three codes, or null), how long the audio was, and what the call cost:
//
//   transcribe(audio, { filename, languageHint }) ->
//     { text, language, durationSeconds, costUsd }
//
// The point of having more than one is to find out, not to assume. Whisper
// hears Spanish and French well and reports the language; Scribe claims the
// best word accuracy on accented speech; Nova is the fastest and cheapest per
// minute. Which of those matters for a travel agent on a bad line in a busy
// office is a question with an empirical answer, and the Travel Voice tab
// exists to get it: same note, three ears, compare.
//
// Each provider's request shape and prices are pinned by hand here, like
// every other provider in this app, and overridable by variable because
// audio APIs rename models and formats faster than files get edited.

import { readSecret, hasSecret } from '../../env.js';
import { transcribeModel } from '../../agents/openai.js';
import { normalizeLanguage } from '../languages.js';

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Opus voice notes run about 2 KB per second; when a provider reports no
// duration this keeps the cap metering something rather than nothing.
function estimateSeconds(audio) {
  return (audio?.length || 0) / 2000;
}

function mimeFor(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return { ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', mp4: 'audio/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' }[ext] || 'application/octet-stream';
}

async function failure(label, response) {
  const detail = await response.text().catch(() => '');
  const err = new Error(`${label} transcription failed (${response.status}): ${detail.slice(0, 200)}`);
  err.status = response.status;
  return err;
}

// --- OpenAI (Whisper and the gpt-4o transcribers) ---------------------------

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';

// Only whisper-1 reports the language it heard. gpt-4o-transcribe and its
// mini sibling reject verbose_json outright, so the request shape depends on
// the model.
function whisperReportsLanguage(model) {
  return /^whisper/i.test(model);
}

export const openaiEars = {
  id: 'openai',
  label: 'OpenAI Whisper',
  configured: () => hasSecret('OPENAI_API_KEY'),
  model: () => transcribeModel(),
  languages: ['es', 'fr', 'en'],
  pricePerMinute: () => numberFromEnv('TRAVEL_VOICE_STT_PRICE_PER_MIN', 0.006),
  async transcribe(audio, { filename = 'voice.ogg', languageHint = null } = {}) {
    const apiKey = readSecret('OPENAI_API_KEY');
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    const model = transcribeModel();
    const form = new FormData();
    form.append('file', new Blob([audio]), filename);
    form.append('model', model);
    form.append('response_format', whisperReportsLanguage(model) ? 'verbose_json' : 'json');
    const hint = normalizeLanguage(languageHint);
    if (hint) form.append('language', hint);

    const response = await fetch(OPENAI_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    if (!response.ok) throw await failure('OpenAI', response);

    const data = await response.json();
    const durationSeconds = Number.isFinite(data?.duration) ? data.duration : null;
    return {
      text: (data?.text || '').trim(),
      language: hint || normalizeLanguage(data?.language),
      durationSeconds,
      costUsd: ((durationSeconds ?? estimateSeconds(audio)) / 60) * this.pricePerMinute(),
    };
  },
};

// --- ElevenLabs Scribe ------------------------------------------------------

const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

export const elevenLabsEars = {
  id: 'elevenlabs',
  label: 'ElevenLabs Scribe',
  configured: () => hasSecret('ELEVENLABS_API_KEY'),
  model: () => (process.env.ELEVENLABS_STT_MODEL || '').trim() || 'scribe_v2',
  languages: ['es', 'fr', 'en'],
  // Scribe is billed per hour of audio; $0.40/hour on the API tiers checked
  // 2026-09-19, so a little under a cent a minute.
  pricePerMinute: () => numberFromEnv('ELEVENLABS_STT_PRICE_PER_MIN', 0.0067),
  async transcribe(audio, { filename = 'voice.ogg', languageHint = null } = {}) {
    const apiKey = readSecret('ELEVENLABS_API_KEY');
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mimeFor(filename) }), filename);
    form.append('model_id', this.model());
    const hint = normalizeLanguage(languageHint);
    if (hint) form.append('language_code', hint);
    // Speaker labels and audio-event tags are for meeting transcripts; a
    // voice note has one speaker and the advisor wants the words only.
    form.append('diarize', 'false');
    form.append('tag_audio_events', 'false');

    const response = await fetch(ELEVENLABS_STT_URL, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form });
    if (!response.ok) throw await failure('ElevenLabs', response);

    const data = await response.json();
    // Scribe reports ISO 639-1 or 639-3 ("spa", "fra", "eng") depending on
    // the model; the three-letter forms are mapped here rather than in
    // languages.js, since nothing else in the app produces them.
    const code = String(data?.language_code || '').toLowerCase();
    const heard = normalizeLanguage(code) || { spa: 'es', fra: 'fr', fre: 'fr', eng: 'en' }[code] || null;
    // Duration is not in the response; the last word's end time is the next
    // best thing and is usually within a second of it.
    const words = Array.isArray(data?.words) ? data.words : [];
    const last = words.length ? words[words.length - 1] : null;
    const durationSeconds = Number.isFinite(last?.end) ? last.end : null;
    return {
      text: (data?.text || '').trim(),
      language: hint || heard,
      durationSeconds,
      costUsd: ((durationSeconds ?? estimateSeconds(audio)) / 60) * this.pricePerMinute(),
    };
  },
};

// --- Deepgram Nova ------------------------------------------------------------

const DEEPGRAM_STT_URL = 'https://api.deepgram.com/v1/listen';

export const deepgramEars = {
  id: 'deepgram',
  label: 'Deepgram Nova',
  configured: () => hasSecret('DEEPGRAM_API_KEY'),
  model: () => (process.env.DEEPGRAM_STT_MODEL || '').trim() || 'nova-3',
  languages: ['es', 'fr', 'en'],
  // Nova-3 pay-as-you-go, checked 2026-09-19.
  pricePerMinute: () => numberFromEnv('DEEPGRAM_STT_PRICE_PER_MIN', 0.0077),
  async transcribe(audio, { filename = 'voice.ogg', languageHint = null } = {}) {
    const apiKey = readSecret('DEEPGRAM_API_KEY');
    if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set');
    const params = new URLSearchParams({ model: this.model(), smart_format: 'true', punctuate: 'true' });
    // Keyterm prompting: the words the transcriber should expect. On a
    // travel line that is the Amadeus vocabulary and the airport codes —
    // "FXP" heard as "effects P" is the failure it prevents. Opt-in by
    // variable because Deepgram documents it for Nova-3 with per-language
    // coverage that has changed between releases, and a rejected
    // parameter would fail every transcription rather than one word.
    for (const term of deepgramKeyterms()) params.append('keyterm', term);
    const hint = normalizeLanguage(languageHint);
    // Told the language when the caller chose one; asked to detect it
    // otherwise. Sending both makes the detection redundant and the hint a
    // suggestion, which is not what "chosen" means.
    if (hint) params.set('language', hint);
    else params.set('detect_language', 'true');

    const response = await fetch(`${DEEPGRAM_STT_URL}?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': mimeFor(filename) },
      body: audio,
    });
    if (!response.ok) throw await failure('Deepgram', response);

    const data = await response.json();
    const channel = data?.results?.channels?.[0];
    const durationSeconds = Number.isFinite(data?.metadata?.duration) ? data.metadata.duration : null;
    return {
      text: (channel?.alternatives?.[0]?.transcript || '').trim(),
      language: hint || normalizeLanguage(channel?.detected_language),
      durationSeconds,
      costUsd: ((durationSeconds ?? estimateSeconds(audio)) / 60) * this.pricePerMinute(),
    };
  },
};

/** The keyterms Deepgram is told to expect, from DEEPGRAM_KEYTERMS, comma-separated. */
export function deepgramKeyterms() {
  return (process.env.DEEPGRAM_KEYTERMS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 100);
}

// --- AssemblyAI Universal -------------------------------------------------------

// The one ear here that claims to follow a speaker who changes language
// mid-sentence — "el cliente quiere un refund, ¿qué hago?" — in a single
// pass rather than picking one language for the whole note. Whether that
// claim survives an agency's actual voice notes is what the comparison is
// for. The API is asynchronous: upload the bytes, ask for a transcript,
// poll until it is done. A few seconds on a short note.
const ASSEMBLYAI_URL = 'https://api.assemblyai.com/v2';

function assemblyPollMs() {
  return numberFromEnv('ASSEMBLYAI_POLL_MS', 500);
}

function assemblyTimeoutMs() {
  return numberFromEnv('ASSEMBLYAI_TIMEOUT_MS', 60000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const assemblyAiEars = {
  id: 'assemblyai',
  label: 'AssemblyAI Universal',
  configured: () => hasSecret('ASSEMBLYAI_API_KEY'),
  model: () => (process.env.ASSEMBLYAI_STT_MODEL || '').trim() || 'universal',
  languages: ['es', 'fr', 'en'],
  // Universal pay-as-you-go, per hour of audio, checked 2026-09-19.
  pricePerMinute: () => numberFromEnv('ASSEMBLYAI_STT_PRICE_PER_MIN', 0.0025),
  async transcribe(audio, { filename = 'voice.ogg', languageHint = null } = {}) {
    const apiKey = readSecret('ASSEMBLYAI_API_KEY');
    if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY is not set');
    const headers = { authorization: apiKey };

    const uploaded = await fetch(`${ASSEMBLYAI_URL}/upload`, { method: 'POST', headers: { ...headers, 'Content-Type': mimeFor(filename) }, body: audio });
    if (!uploaded.ok) throw await failure('AssemblyAI', uploaded);
    const { upload_url: audioUrl } = await uploaded.json();
    if (!audioUrl) throw new Error('AssemblyAI returned no upload URL');

    const hint = normalizeLanguage(languageHint);
    const body = { audio_url: audioUrl, speech_model: this.model() };
    // Chosen beats detected, as with every ear here. No speaker labels and
    // no sentiment or entity analysis: one speaker, and nothing about the
    // person is wanted, only the words.
    if (hint) body.language_code = hint;
    else body.language_detection = true;

    const created = await fetch(`${ASSEMBLYAI_URL}/transcript`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!created.ok) throw await failure('AssemblyAI', created);
    const { id } = await created.json();
    if (!id) throw new Error('AssemblyAI returned no transcript id');

    const deadline = Date.now() + assemblyTimeoutMs();
    let data;
    for (;;) {
      const polled = await fetch(`${ASSEMBLYAI_URL}/transcript/${encodeURIComponent(id)}`, { headers });
      if (!polled.ok) throw await failure('AssemblyAI', polled);
      data = await polled.json();
      if (data.status === 'completed') break;
      if (data.status === 'error') throw new Error(`AssemblyAI transcription failed: ${String(data.error || 'unknown error').slice(0, 200)}`);
      if (Date.now() > deadline) throw new Error('AssemblyAI transcription timed out');
      await sleep(assemblyPollMs());
    }

    const durationSeconds = Number.isFinite(data?.audio_duration) ? data.audio_duration : null;
    return {
      text: (data?.text || '').trim(),
      language: hint || normalizeLanguage(data?.language_code),
      durationSeconds,
      costUsd: ((durationSeconds ?? estimateSeconds(audio)) / 60) * this.pricePerMinute(),
    };
  },
};

// Preference order when nothing chose: the one that was already here first.
export const EARS = [openaiEars, elevenLabsEars, deepgramEars, assemblyAiEars];
