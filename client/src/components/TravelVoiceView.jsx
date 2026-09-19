import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchTravelVoiceStatus,
  sendTravelVoiceText,
  sendTravelVoiceAudio,
  resetTravelVoiceConversation,
  startTravelVoiceOutreach,
  registerTravelVoiceVenture,
} from '../api/chat.js';

// The travel advisor, in the browser. This is how the venture's product gets
// tried without a Meta number: hold the button, ask in Spanish, French or
// English, hear the answer. It talks to the same server code the WhatsApp
// number does, so what works here works on a phone.
//
// Recording uses MediaRecorder rather than the Web Speech API the Jarvis tab
// uses, because the point is to exercise the server's ears — the same
// transcription a WhatsApp voice note gets — not the browser's.

const LANGUAGES = [
  { code: '', label: 'Auto-detect' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'English' },
];

const LANGUAGE_LABEL = { es: 'Español', fr: 'Français', en: 'English' };

const SOURCE_LABEL = {
  chosen: 'you chose it',
  heard: 'heard in the voice note',
  guessed: 'guessed from the words',
  previous: 'kept from earlier in the conversation',
  switched: 'you asked to switch',
  default: 'default',
};

function getSessionId() {
  let id = localStorage.getItem('jarvis-travel-session-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('jarvis-travel-session-id', id);
  }
  return id;
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function Capability({ ok, label, hint }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span className={`mt-0.5 inline-block w-2 h-2 rounded-full shrink-0 ${ok ? 'bg-emerald-400' : 'bg-cyan-500/30'}`} />
      <span className={ok ? 'text-cyan-50/90' : 'text-cyan-400/60'}>
        {label}
        {!ok && hint ? <span className="block text-[11px] text-cyan-500/50">{hint}</span> : null}
      </span>
    </li>
  );
}

function Bubble({ role, text, meta, audioUrl, autoPlay }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[80%] space-y-1">
        {meta && <div className="text-[10px] uppercase tracking-wide text-cyan-400/60 px-1">{meta}</div>}
        <div
          className={`rounded-2xl px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
            isUser ? 'bg-cyan-600/80 text-white' : 'bg-white/5 border border-cyan-500/20 text-cyan-50/90'
          }`}
        >
          {text}
        </div>
        {audioUrl && (
          <audio controls autoPlay={autoPlay} src={audioUrl} className="w-full h-8 opacity-80" preload="auto" />
        )}
      </div>
    </div>
  );
}

export default function TravelVoiceView({ onVenturesChanged }) {
  const sessionId = useMemo(getSessionId, []);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [language, setLanguage] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState(null);
  const [registering, setRegistering] = useState(false);

  const [outreachTo, setOutreachTo] = useState('');
  const [outreachLanguage, setOutreachLanguage] = useState('es');
  const [outreachMessage, setOutreachMessage] = useState('');
  const [outreachResult, setOutreachResult] = useState(null);
  const [outreachBusy, setOutreachBusy] = useState(false);

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const bottomRef = useRef(null);
  const mimeType = useMemo(pickMimeType, []);

  const loadStatus = useCallback(() => {
    fetchTravelVoiceStatus()
      .then((s) => {
        setStatus(s);
        setStatusError(null);
      })
      .catch((err) => setStatusError(err?.response?.data?.error || err.message));
  }, []);

  useEffect(loadStatus, [loadStatus]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Object URLs for the reply audio are revoked when the tab unmounts.
  useEffect(() => {
    return () => {
      messages.forEach((m) => m.audioUrl && URL.revokeObjectURL(m.audioUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const append = useCallback((m) => setMessages((prev) => [...prev, m]), []);

  const handleReply = useCallback(
    (data) => {
      let audioUrl = null;
      if (data.audio) {
        const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
        audioUrl = URL.createObjectURL(new Blob([bytes], { type: data.audioMimeType || 'audio/ogg' }));
      }
      const source = SOURCE_LABEL[data.languageSource] || data.languageSource;
      append({
        role: 'assistant',
        text: data.reply,
        meta: `${LANGUAGE_LABEL[data.language] || data.language}${source ? ` · ${source}` : ''}${
          data.toolCalls?.length ? ` · looked up: ${data.toolCalls.join(', ')}` : ''
        }${data.audioError ? ` · no audio: ${data.audioError}` : ''}`,
        audioUrl,
        autoPlay: Boolean(audioUrl),
      });
      loadStatus();
    },
    [append, loadStatus]
  );

  const submitText = useCallback(
    async (text) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setError(null);
      append({ role: 'user', text: trimmed });
      setInput('');
      setBusy(true);
      try {
        const data = await sendTravelVoiceText(sessionId, trimmed, { language, wantAudio: Boolean(status?.capabilities?.voice) });
        handleReply(data);
      } catch (err) {
        setError(err?.response?.data?.error || err.message);
      } finally {
        setBusy(false);
      }
    },
    [busy, append, sessionId, language, status, handleReply]
  );

  const submitAudio = useCallback(
    async (blob) => {
      setError(null);
      const localUrl = URL.createObjectURL(blob);
      append({ role: 'user', text: '🎤 voice note', audioUrl: localUrl });
      setBusy(true);
      try {
        const data = await sendTravelVoiceAudio(sessionId, blob, { language });
        // Replace the placeholder with what the server heard.
        setMessages((prev) => {
          const idx = prev.map((m) => m.audioUrl).lastIndexOf(localUrl);
          if (idx < 0) return prev;
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], text: data.transcript ? `🎤 ${data.transcript}` : '🎤 (nothing heard)' };
          return copy;
        });
        if (data.empty) {
          append({ role: 'assistant', text: data.reply, meta: LANGUAGE_LABEL[data.language] || data.language });
        } else {
          handleReply(data);
        }
      } catch (err) {
        setError(err?.response?.data?.error || err.message);
      } finally {
        setBusy(false);
      }
    },
    [append, sessionId, language, handleReply]
  );

  const startRecording = useCallback(async () => {
    if (recording || busy || mimeType === null) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
        if (blob.size > 0) submitAudio(blob);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      setError(`Microphone unavailable — ${err.message}`);
    }
  }, [recording, busy, mimeType, submitAudio]);

  const stopRecording = useCallback(() => {
    if (!recording) return;
    setRecording(false);
    recorderRef.current?.stop();
  }, [recording]);

  const handleReset = async () => {
    await resetTravelVoiceConversation(sessionId);
    messages.forEach((m) => m.audioUrl && URL.revokeObjectURL(m.audioUrl));
    setMessages([]);
    setError(null);
  };

  const handleRegister = async () => {
    setRegistering(true);
    try {
      await registerTravelVoiceVenture();
      loadStatus();
      onVenturesChanged?.();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setRegistering(false);
    }
  };

  const handleOutreach = async (e) => {
    e.preventDefault();
    if (!outreachTo.trim() || outreachBusy) return;
    setOutreachBusy(true);
    setOutreachResult(null);
    try {
      const result = await startTravelVoiceOutreach({ to: outreachTo.trim(), language: outreachLanguage, message: outreachMessage.trim() });
      setOutreachResult(
        `Sent: intro${result.permissionRequested ? ', call permission request' : ''}${result.spoke ? ', voice note' : ''}${
          result.called ? `, and placed call ${result.callId}` : ''
        }.`
      );
      loadStatus();
    } catch (err) {
      setOutreachResult(`Couldn't reach out — ${err?.response?.data?.error || err.message}`);
    } finally {
      setOutreachBusy(false);
    }
  };

  const caps = status?.capabilities;
  const canRecord = mimeType !== null && Boolean(caps?.voice);

  return (
    <div className="flex-1 flex min-h-0">
      <aside className="hidden md:flex md:flex-col w-80 shrink-0 border-r border-cyan-500/20 overflow-y-auto p-4 space-y-5 text-sm">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-cyan-300 mb-1">Travel Voice Advisor</h2>
          <p className="text-xs text-cyan-400/70 leading-relaxed">
            A voice-to-voice Amadeus and travel-industry helpdesk on WhatsApp — Spanish, French and English. This tab talks to the
            same advisor a WhatsApp caller gets.
          </p>
        </div>

        {statusError && <p className="text-xs text-red-300">{statusError}</p>}

        {status && (
          <>
            <ul className="space-y-1.5">
              <Capability ok={caps.text} label={`Advisor on ${status.model}`} hint="Needs ANTHROPIC_API_KEY." />
              <Capability
                ok={caps.voice}
                label={caps.voice ? `Voice in and out (${status.voice.model}, voice "${status.voice.voice}")` : 'Voice in and out'}
                hint="Set OPENAI_API_KEY to hear and speak."
              />
              <Capability
                ok={caps.liveFares}
                label={caps.liveFares ? `Live fares from Amadeus (${status.amadeus.environment})` : 'Live fares from Amadeus'}
                hint="Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to search real flight offers."
              />
              <Capability
                ok={caps.whatsapp}
                label={caps.whatsapp ? `WhatsApp number ${status.whatsapp.phoneNumberId}` : 'Its own WhatsApp number'}
                hint="Set TRAVEL_VOICE_PHONE_NUMBER_ID, or send TRAVEL ON from the founder line to try it there."
              />
              <Capability ok={caps.liveCalls} label="Live WhatsApp calls" hint="Voice notes work now; live calls need a media bridge (see travelVoice/calls.js)." />
            </ul>
            <div className="text-[11px] text-cyan-500/60">
              {status.whatsapp.open ? 'Open to any caller' : `${status.whatsapp.allowedCallers} allowed caller(s)`} · up to{' '}
              {status.whatsapp.maxTurnsPerHour} turns an hour each.
            </div>

            <div className="border border-cyan-500/20 rounded-lg p-3 space-y-2">
              <div className="text-[10px] uppercase tracking-wide text-cyan-400/70">Venture</div>
              {status.venture ? (
                <p className="text-xs text-cyan-50/90">
                  On the portfolio as <span className="text-cyan-300">{status.venture.title}</span> ({status.venture.status}).
                </p>
              ) : (
                <>
                  <p className="text-xs text-cyan-400/70">Not yet on the portfolio, so the team cannot sell or report on it.</p>
                  <button
                    onClick={handleRegister}
                    disabled={registering}
                    className="text-xs border border-cyan-500/40 rounded px-2 py-1 text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40"
                  >
                    {registering ? 'Registering…' : 'Register as a venture'}
                  </button>
                </>
              )}
            </div>

            {caps.whatsapp && (
              <form onSubmit={handleOutreach} className="border border-cyan-500/20 rounded-lg p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-cyan-400/70">Reach out first</div>
                <p className="text-[11px] text-cyan-500/60">
                  Sends an introduction, a call-permission request and your message as a voice note, from the advisor's number.
                </p>
                <input
                  value={outreachTo}
                  onChange={(e) => setOutreachTo(e.target.value)}
                  placeholder="+34 600 000 000"
                  className="w-full bg-white/5 border border-cyan-500/20 rounded px-2 py-1 text-xs outline-none focus:border-cyan-400/60"
                />
                <select
                  value={outreachLanguage}
                  onChange={(e) => setOutreachLanguage(e.target.value)}
                  className="w-full bg-[#0b0d10] border border-cyan-500/20 rounded px-2 py-1 text-xs"
                >
                  {LANGUAGES.filter((l) => l.code).map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <textarea
                  value={outreachMessage}
                  onChange={(e) => setOutreachMessage(e.target.value)}
                  rows={3}
                  placeholder="What the advisor should say in the voice note (optional)"
                  className="w-full bg-white/5 border border-cyan-500/20 rounded px-2 py-1 text-xs outline-none focus:border-cyan-400/60"
                />
                <button
                  type="submit"
                  disabled={outreachBusy || !outreachTo.trim()}
                  className="text-xs border border-cyan-500/40 rounded px-2 py-1 text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40"
                >
                  {outreachBusy ? 'Sending…' : 'Send'}
                </button>
                {outreachResult && <p className="text-[11px] text-cyan-400/80">{outreachResult}</p>}
              </form>
            )}

            {status.recentTurns?.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-cyan-400/70 mb-1">Recent conversations</div>
                <ul className="space-y-1">
                  {status.recentTurns.slice(0, 8).map((t, i) => (
                    <li key={i} className="text-[11px] text-cyan-50/80 leading-snug">
                      <span className="text-cyan-400/60">
                        {t.channel} {t.from || ''} · {t.language || '?'} · {t.stage}
                        {t.voice ? ' · 🎤' : ''}
                      </span>
                      {t.transcript && <div className="truncate">“{t.transcript}”</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-cyan-500/20 text-xs">
          <label className="flex items-center gap-2 text-cyan-400/80">
            Answer in
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="bg-[#0b0d10] border border-cyan-500/20 rounded px-2 py-1"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code || 'auto'} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <button onClick={handleReset} className="text-cyan-400/80 hover:text-cyan-300 border border-cyan-500/30 rounded px-2 py-1">
            new conversation
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-3">
          {messages.length === 0 && (
            <div className="text-center text-cyan-500/50 text-sm mt-12 space-y-2">
              <p>Hold the microphone and ask in Spanish, French or English — or type.</p>
              <p className="text-xs">
                Try: “¿Cómo valoro un PNR con la tarifa más baja?” · “Comment annuler un segment sans perdre le PNR ?” · “What does
                fare basis ONNAZ tell me?”
              </p>
            </div>
          )}
          {messages.map((m, i) => (
            <Bubble key={i} {...m} />
          ))}
          {busy && <p className="text-xs text-cyan-400/60">The advisor is thinking…</p>}
          {error && <p className="text-xs text-red-300">{error}</p>}
          <div ref={bottomRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitText(input);
          }}
          className="flex items-center gap-2 p-4 border-t border-cyan-500/20"
        >
          <button
            type="button"
            disabled={!canRecord || busy}
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onMouseLeave={stopRecording}
            onTouchStart={(e) => {
              e.preventDefault();
              startRecording();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              stopRecording();
            }}
            title={
              !canRecord
                ? mimeType === null
                  ? 'This browser cannot record audio'
                  : 'Voice needs OPENAI_API_KEY on the server'
                : 'Hold to talk'
            }
            className={`shrink-0 flex items-center justify-center w-11 h-11 rounded-full border transition select-none disabled:opacity-30 disabled:cursor-not-allowed ${
              recording ? 'bg-red-500/20 border-red-400 text-red-300 animate-pulse' : 'bg-white/5 border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10'
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={recording ? 'Listening… release to send' : 'Ask about Amadeus, fares, PNRs, tickets…'}
            className="flex-1 bg-white/5 border border-cyan-500/20 rounded-full px-4 py-2 text-sm outline-none focus:border-cyan-400/60"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="shrink-0 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white rounded-full px-4 py-2 text-sm"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
