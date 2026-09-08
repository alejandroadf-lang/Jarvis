import { useEffect, useRef, useState } from 'react';

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

const WAKE_PHRASE = /\bhey,?\s*jarvis\b/i;

/**
 * Listens continuously in the background for "Hey Jarvis" followed by a
 * command, e.g. "Hey Jarvis, what's on my calendar today?" — said in one
 * breath or as two separate turns. Calls `onCommand(text)` once a command
 * is captured. Runs independently of the manual push-to-talk mic button.
 */
export function useWakeWord({ enabled, onCommand } = {}) {
  const [armed, setArmed] = useState(false); // heard the wake phrase, waiting for the command
  const armedRef = useRef(false);
  const shouldRunRef = useRef(false);

  useEffect(() => {
    if (!SpeechRecognitionImpl || !enabled) {
      armedRef.current = false;
      setArmed(false);
      return;
    }

    shouldRunRef.current = true;
    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const transcript = result[0].transcript.trim();
      if (!transcript) return;

      if (!armedRef.current) {
        if (!WAKE_PHRASE.test(transcript)) return;
        const command = transcript.replace(WAKE_PHRASE, '').trim();
        if (command && result.isFinal) {
          onCommand?.(command);
        } else {
          armedRef.current = true;
          setArmed(true);
        }
        return;
      }

      if (result.isFinal) {
        armedRef.current = false;
        setArmed(false);
        onCommand?.(transcript);
      }
    };

    // 'no-speech' and similar fire constantly during idle listening — expected,
    // not a real failure. onend below restarts the session regardless.
    recognition.onerror = () => {};
    recognition.onend = () => {
      if (shouldRunRef.current) {
        try {
          recognition.start();
        } catch {
          // already running — ignore
        }
      }
    };

    try {
      recognition.start();
    } catch {
      // ignore — a stray double-start on fast re-renders
    }

    return () => {
      shouldRunRef.current = false;
      recognition.onend = null;
      recognition.stop();
      armedRef.current = false;
      setArmed(false);
    };
  }, [enabled, onCommand]);

  return { armed, supported: Boolean(SpeechRecognitionImpl) };
}
