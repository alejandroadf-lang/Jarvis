import { useCallback, useEffect, useRef, useState } from 'react';

const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

// Ranked preferences for a calm, "assistant" voice, closest to what most
// browsers ship for a JARVIS-style delivery — a measured male English voice
// over the shrill/robotic default. Falls back gracefully down the list.
const VOICE_RULES = [
  (v) => /Daniel/i.test(v.name), // macOS/iOS UK male
  (v) => /Google UK English Male/i.test(v.name), // Chrome/Android
  (v) => /Microsoft (Guy|Ryan|George)/i.test(v.name), // Windows/Edge
  (v) => /en-GB/i.test(v.lang) && /male/i.test(v.name),
  (v) => /en-GB/i.test(v.lang),
  (v) => /en-US/i.test(v.lang) && /male/i.test(v.name),
  (v) => /^en/i.test(v.lang),
];

function pickVoice(voices) {
  for (const rule of VOICE_RULES) {
    const match = voices.find(rule);
    if (match) return match;
  }
  return voices[0] || null;
}

export function useSpeechSynthesis() {
  const [speaking, setSpeaking] = useState(false);
  const voiceRef = useRef(null);

  useEffect(() => {
    if (!supported) return;
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) voiceRef.current = pickVoice(voices);
    };
    loadVoices();
    // Chrome loads voices asynchronously; this fires once they're ready.
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, []);

  const settleWhenQueueEmpty = useCallback(() => {
    if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
      setSpeaking(false);
    }
  }, []);

  // Adds an utterance to the browser's speech queue without interrupting
  // whatever is already speaking or queued — used to speak a reply
  // sentence-by-sentence as it streams in.
  const enqueue = useCallback(
    (text) => {
      if (!supported || !text?.trim()) return;
      const utterance = new SpeechSynthesisUtterance(text);
      if (voiceRef.current) utterance.voice = voiceRef.current;
      utterance.pitch = 0.9;
      utterance.rate = 1.02;
      utterance.onstart = () => setSpeaking(true);
      utterance.onend = settleWhenQueueEmpty;
      utterance.onerror = settleWhenQueueEmpty;
      window.speechSynthesis.speak(utterance);
    },
    [settleWhenQueueEmpty]
  );

  // Replaces whatever is currently speaking/queued with a single utterance —
  // used for a complete, non-streamed reply.
  const speak = useCallback(
    (text) => {
      if (!supported || !text) return;
      window.speechSynthesis.cancel();
      enqueue(text);
    },
    [enqueue]
  );

  const cancel = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  return { speak, enqueue, cancel, speaking, supported };
}
