import { useCallback, useMemo, useState } from 'react';
import ChatWindow from './components/ChatWindow.jsx';
import VoiceButton from './components/VoiceButton.jsx';
import OrgChart from './components/OrgChart.jsx';
import VenturesPanel from './components/VenturesPanel.jsx';
import PortfolioView from './components/PortfolioView.jsx';
import { useSpeechRecognition } from './hooks/useSpeechRecognition.js';
import { useSpeechSynthesis } from './hooks/useSpeechSynthesis.js';
import { useWakeWord } from './hooks/useWakeWord.js';
import {
  sendMessage,
  resetConversation,
  sendCompanyMessage,
  resetCompanyConversation,
  sendStudioMessage,
  resetStudioConversation,
} from './api/chat.js';

function getSessionId() {
  let id = localStorage.getItem('jarvis-session-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('jarvis-session-id', id);
  }
  return id;
}

// Pulls complete sentences off the front of a streaming text buffer, leaving
// any trailing partial sentence for the next chunk. Lets Jarvis start
// speaking a sentence while the rest of the reply is still generating.
function extractSentences(buffer) {
  const sentences = [];
  let rest = buffer;
  let match;
  while ((match = rest.match(/[^.!?\n]*[.!?\n]+/))) {
    const sentence = match[0].trim();
    if (sentence) sentences.push(sentence);
    rest = rest.slice(match[0].length);
  }
  return { sentences, rest };
}

const MODES = {
  jarvis: {
    label: 'Jarvis',
    placeholder: 'Message Jarvis…',
    emptyHint: 'Say something, or type below to get started.',
    send: sendMessage,
    reset: resetConversation,
  },
  company: {
    label: 'Executive Team',
    placeholder: 'Ask the executive team…',
    emptyHint: "Ask for anything — the CEO will route it to the right department.",
    send: sendCompanyMessage,
    reset: resetCompanyConversation,
  },
  studio: {
    label: 'Venture Studio',
    placeholder: 'Pitch an idea, or ask the team to brainstorm…',
    emptyHint:
      "Brainstorm here. When an idea is ready, the Venture Partner logs it as a proposal you can greenlight and push to the company.",
    send: sendStudioMessage,
    reset: resetStudioConversation,
  },
};

export default function App() {
  const sessionId = useMemo(getSessionId, []);
  const [mode, setMode] = useState('jarvis');
  const [messagesByMode, setMessagesByMode] = useState({ jarvis: [], company: [], studio: [] });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [venturesReloadKey, setVenturesReloadKey] = useState(0);

  const isPortfolio = mode === 'portfolio';
  const messages = messagesByMode[mode] || [];
  const modeConfig = MODES[mode] || null;

  const { speak, enqueue, speaking, cancel, supported: ttsSupported } = useSpeechSynthesis();

  const appendMessage = useCallback(
    (m, targetMode = mode) => {
      setMessagesByMode((prev) => ({ ...prev, [targetMode]: [...prev[targetMode], m] }));
    },
    [mode]
  );

  const updateLastMessage = useCallback((content, targetMode = mode) => {
    setMessagesByMode((prev) => {
      const list = prev[targetMode];
      const updated = list.slice(0, -1).concat({ ...list[list.length - 1], content });
      return { ...prev, [targetMode]: updated };
    });
  }, [mode]);

  const submit = useCallback(
    async (text) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      appendMessage({ role: 'user', content: trimmed });
      setInput('');
      setSending(true);
      try {
        if (mode === 'jarvis') {
          appendMessage({ role: 'assistant', content: '' });
          let sentenceBuffer = '';
          await sendMessage(sessionId, trimmed, (delta, full) => {
            updateLastMessage(full);
            if (!speakReplies) return;
            sentenceBuffer += delta;
            const { sentences, rest } = extractSentences(sentenceBuffer);
            sentenceBuffer = rest;
            sentences.forEach(enqueue);
          });
          if (speakReplies && sentenceBuffer.trim()) enqueue(sentenceBuffer);
        } else {
          const { reply, trace } = await modeConfig.send(sessionId, trimmed);
          appendMessage({ role: 'assistant', content: reply, trace });
          if (speakReplies) speak(reply);
          // Either team can now touch the treasury (studio proposes/spends,
          // the CFO logs revenue), so refresh the panel after any turn.
          setVenturesReloadKey((k) => k + 1);
        }
      } catch {
        const errorText = 'Sorry, I ran into a problem reaching the server.';
        // Jarvis mode already appended an (empty, streaming) placeholder bubble
        // before the request started — fill that in rather than adding a new one.
        if (mode === 'jarvis') {
          updateLastMessage(errorText);
        } else {
          appendMessage({ role: 'assistant', content: errorText });
        }
      } finally {
        setSending(false);
      }
    },
    [sending, sessionId, speak, enqueue, speakReplies, mode, modeConfig, appendMessage, updateLastMessage]
  );

  const { listening, start, stop, supported: sttSupported } = useSpeechRecognition({
    onResult: submit,
  });

  const { armed: wakeArmed, supported: wakeWordSupported } = useWakeWord({
    enabled: wakeWordEnabled && mode === 'jarvis',
    onCommand: submit,
  });

  const handleReset = async () => {
    if (!modeConfig) return;
    await modeConfig.reset(sessionId);
    setMessagesByMode((prev) => ({ ...prev, [mode]: [] }));
    cancel();
  };

  const handleGreenlit = useCallback(
    (result) => {
      if (!result.companyBriefing) return;
      appendMessage({ role: 'user', content: result.companyBriefing.message }, 'company');
      appendMessage(
        { role: 'assistant', content: result.companyBriefing.reply, trace: result.companyBriefing.trace },
        'company'
      );
      setMode('company');
    },
    [appendMessage]
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#0b0d10] text-cyan-50">
      <header className="flex items-center justify-between px-4 py-3 border-b border-cyan-500/20">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold tracking-wide text-cyan-300">JARVIS</h1>
          <div className="flex items-center text-xs border border-cyan-500/30 rounded-full overflow-hidden">
            {Object.entries(MODES).map(([key, cfg]) => (
              <button
                key={key}
                onClick={() => setMode(key)}
                className={`px-3 py-1 transition-colors ${
                  mode === key ? 'bg-cyan-600 text-white' : 'text-cyan-400/80 hover:text-cyan-300'
                }`}
              >
                {cfg.label}
              </button>
            ))}
            <button
              onClick={() => setMode('portfolio')}
              className={`px-3 py-1 transition-colors ${
                isPortfolio ? 'bg-cyan-600 text-white' : 'text-cyan-400/80 hover:text-cyan-300'
              }`}
            >
              Portfolio
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {mode === 'jarvis' && wakeWordSupported && (
            <label className="flex items-center gap-1 cursor-pointer select-none text-cyan-400/80">
              <input
                type="checkbox"
                checked={wakeWordEnabled}
                onChange={(e) => setWakeWordEnabled(e.target.checked)}
              />
              "Hey Jarvis"
            </label>
          )}
          {ttsSupported && (
            <label className="flex items-center gap-1 cursor-pointer select-none text-cyan-400/80">
              <input
                type="checkbox"
                checked={speakReplies}
                onChange={(e) => setSpeakReplies(e.target.checked)}
              />
              speak replies
            </label>
          )}
          {!isPortfolio && (
            <button
              onClick={handleReset}
              className="text-cyan-400/80 hover:text-cyan-300 border border-cyan-500/30 rounded px-2 py-1"
            >
              reset
            </button>
          )}
        </div>
      </header>

      {isPortfolio ? (
        <PortfolioView reloadKey={venturesReloadKey} />
      ) : (
      <div className="flex-1 flex min-h-0">
        {mode === 'company' && (
          <aside className="hidden md:flex md:flex-col w-72 shrink-0 border-r border-cyan-500/20 overflow-y-auto">
            <OrgChart kind="company" title="The Company" />
            <VenturesPanel sessionId={sessionId} reloadKey={venturesReloadKey} onGreenlit={handleGreenlit} />
          </aside>
        )}
        {mode === 'studio' && (
          <aside className="hidden md:flex md:flex-col w-72 shrink-0 border-r border-cyan-500/20 overflow-y-auto">
            <OrgChart kind="studio" title="The Studio" />
            <VenturesPanel sessionId={sessionId} reloadKey={venturesReloadKey} onGreenlit={handleGreenlit} />
          </aside>
        )}
        <div className="flex-1 flex flex-col min-w-0">
          <ChatWindow messages={messages} emptyHint={modeConfig.emptyHint} />

          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
            className="flex items-center gap-2 p-4 border-t border-cyan-500/20"
          >
            <VoiceButton
              listening={listening}
              supported={sttSupported}
              disabled={wakeWordEnabled && mode === 'jarvis'}
              onClick={() => (listening ? stop() : start())}
            />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                listening
                  ? 'Listening…'
                  : wakeWordEnabled && mode === 'jarvis'
                    ? wakeArmed
                      ? "Go ahead, I'm listening…"
                      : 'Say "Hey Jarvis" to talk…'
                    : modeConfig.placeholder
              }
              className="flex-1 bg-white/5 border border-cyan-500/20 rounded-full px-4 py-2 text-sm outline-none focus:border-cyan-400/60"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="shrink-0 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white rounded-full px-4 py-2 text-sm"
            >
              Send
            </button>
          </form>
          {speaking && (
            <p className="text-center text-xs text-cyan-500/50 pb-2">Jarvis is speaking…</p>
          )}
          {!speaking && wakeWordEnabled && mode === 'jarvis' && (
            <p className="text-center text-xs text-cyan-500/50 pb-2">
              {wakeArmed ? 'Listening for your command…' : 'Listening for "Hey Jarvis"…'}
            </p>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
