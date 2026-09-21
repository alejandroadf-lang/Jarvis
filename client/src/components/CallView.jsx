import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { useRealtimeCall } from '../hooks/useRealtimeCall.js';

// A live conversation with the company, held in the browser.
//
// Deliberately sparse. The whole point is that you are talking rather than
// reading, so a screen dense enough to reward looking at it is a screen
// competing with the thing it exists to support. What is on it is only what
// you cannot hear: whether you are connected, whether it is currently your
// turn, and whether a question is out with the team.

const STATUS_LABEL = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  live: 'Live',
  ending: 'Ending…',
};

export default function CallView() {
  const [lines, setLines] = useState([]);
  const [ventures, setVentures] = useState([]);
  const [desk, setDesk] = useState('');

  // Which desks exist to answer as. Loaded once; a founder who has no
  // ventures yet simply never sees the switch.
  useEffect(() => {
    axios
      .get('/api/ventures')
      .then((res) => setVentures((res.data?.ventures || []).filter((v) => v.status === 'active')))
      .catch(() => setVentures([]));
  }, []);

  const onTranscript = useCallback((line) => {
    setLines((prev) => [...prev.slice(-40), line]);
  }, []);

  const { status, error, speaking, pendingQuestion, start, hangUp, audioRef } = useRealtimeCall({ onTranscript, desk });
  const live = status === 'live';

  return (
    <div className="flex flex-col h-full max-w-2xl mx-auto w-full px-4 py-6 gap-6">
      <audio ref={audioRef} autoPlay className="hidden" />

      <header className="text-center">
        <h2 className="text-lg font-medium text-cyan-200">
          {desk ? 'The customer desk' : 'Talk to the company'}
        </h2>
        <p className="text-sm text-white/50 mt-1">
          {desk
            ? 'What a customer hears when they call. It knows the product and the price, and nothing about the business.'
            : 'Speak any language and it answers in the same one. Switch mid-sentence and it follows.'}
        </p>
      </header>

      {ventures.length > 0 ? (
        // Switching mid-call would leave the founder talking to a brief that
        // changed underneath them, so it is disabled while connected.
        <div className="flex justify-center">
          <select
            value={desk}
            disabled={live || status === 'connecting'}
            onChange={(e) => setDesk(e.target.value)}
            className="bg-white/5 border border-cyan-500/30 rounded-lg px-3 py-1.5 text-sm text-cyan-100 disabled:opacity-40"
          >
            <option value="">As the founder — full company access</option>
            {ventures.map((v) => (
              <option key={v.id} value={v.id}>
                As the {v.title} desk — what a customer hears
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-4">
        <button
          type="button"
          onClick={live || status === 'connecting' ? hangUp : start}
          disabled={status === 'ending'}
          className={`w-28 h-28 rounded-full border-2 flex items-center justify-center transition disabled:opacity-40 ${
            live
              ? 'bg-red-500/20 border-red-400 text-red-200 hover:bg-red-500/30'
              : 'bg-cyan-500/10 border-cyan-400/50 text-cyan-200 hover:bg-cyan-500/20'
          } ${speaking ? 'ring-4 ring-cyan-400/30' : ''}`}
        >
          {live ? (
            <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
            </svg>
          )}
        </button>

        <div className="text-sm text-white/60 h-5" aria-live="polite">
          {/* One line, because on a call there is nothing to read. */}
          {error
            ? <span className="text-red-300">{error}</span>
            : pendingQuestion
              ? <span className="text-amber-300">Asking the team…</span>
              : speaking
                ? 'Speaking'
                : STATUS_LABEL[status]}
        </div>
      </div>

      {pendingQuestion ? (
        // Shown because it is the one thing happening that you cannot hear:
        // the company is working on something while the voice talks about
        // something else.
        <div className="text-xs text-amber-200/70 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
          Out with the team: “{pendingQuestion}”
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto space-y-3 text-sm">
        {lines.length === 0 && !live ? (
          <p className="text-white/30 text-center pt-8">
            Press the button and start talking. Anything the team has to look into keeps the
            conversation going while they do.
          </p>
        ) : null}

        {lines.map((line, i) => (
          <div key={i} className={line.who === 'you' ? 'text-right' : ''}>
            <span className="text-[11px] uppercase tracking-wide text-white/30">
              {line.who === 'you' ? 'You' : line.who === 'team' ? 'The team' : 'Jarvis'}
            </span>
            <p className={line.who === 'team' ? 'text-amber-100/80' : 'text-white/80'}>{line.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
