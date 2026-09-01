export default function VoiceButton({ listening, supported, onClick }) {
  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      title={listening ? 'Stop listening' : 'Speak to Jarvis'}
      className={`shrink-0 flex items-center justify-center w-11 h-11 rounded-full border transition ${
        listening
          ? 'bg-red-500/20 border-red-400 text-red-300 animate-pulse'
          : 'bg-white/5 border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10'
      }`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    </button>
  );
}
