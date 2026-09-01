import { useCallback, useState } from 'react';

const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

export function useSpeechSynthesis() {
  const [speaking, setSpeaking] = useState(false);

  const speak = useCallback((text) => {
    if (!supported || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }, []);

  const cancel = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  return { speak, cancel, speaking, supported };
}
