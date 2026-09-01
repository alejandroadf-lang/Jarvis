import { useCallback, useMemo, useState } from 'react';
import ChatWindow from './components/ChatWindow.jsx';
import VoiceButton from './components/VoiceButton.jsx';
import { useSpeechRecognition } from './hooks/useSpeechRecognition.js';
import { useSpeechSynthesis } from './hooks/useSpeechSynthesis.js';
import { sendMessage, resetConversation } from './api/chat.js';

function getSessionId() {
  let id = localStorage.getItem('jarvis-session-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('jarvis-session-id', id);
  }
  return id;
}

export default function App() {
  const sessionId = useMemo(getSessionId, []);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);

  const { speak, speaking, cancel, supported: ttsSupported } = useSpeechSynthesis();

  const submit = useCallback(
    async (text) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
      setInput('');
      setSending(true);
      try {
        const reply = await sendMessage(sessionId, trimmed);
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
        if (speakReplies) speak(reply);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: 'Sorry, I ran into a problem reaching the server.' },
        ]);
      } finally {
        setSending(false);
      }
    },
    [sending, sessionId, speak, speakReplies]
  );

  const { listening, start, stop, supported: sttSupported } = useSpeechRecognition({
    onResult: submit,
  });

  const handleReset = async () => {
    await resetConversation(sessionId);
    setMessages([]);
    cancel();
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0b0d10] text-cyan-50">
      <header className="flex items-center justify-between px-4 py-3 border-b border-cyan-500/20">
        <h1 className="text-lg font-semibold tracking-wide text-cyan-300">JARVIS</h1>
        <div className="flex items-center gap-3 text-xs">
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
          <button
            onClick={handleReset}
            className="text-cyan-400/80 hover:text-cyan-300 border border-cyan-500/30 rounded px-2 py-1"
          >
            reset
          </button>
        </div>
      </header>

      <ChatWindow messages={messages} />

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
          onClick={() => (listening ? stop() : start())}
        />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={listening ? 'Listening…' : 'Message Jarvis…'}
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
    </div>
  );
}
