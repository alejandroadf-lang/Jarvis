import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

// A real conversation, held in the browser.
//
// The audio goes straight from this page to OpenAI over WebRTC. The server is
// not in the media path at all — it mints a short-lived token and answers the
// one question the voice cannot answer itself. That is what makes this
// possible on a host that does not accept inbound UDP, and it is also why it
// sounds better than the phone line: a browser gets full-band Opus where a
// phone gets eight-kilohertz mu-law.
//
// Two things here are worth knowing before changing anything:
//
//   1. The data channel carries events, the media track carries audio. Both
//      are needed. Sending audio without the channel means no tool calls and
//      no transcripts; the channel without audio means a very fast text chat.
//   2. `ask_the_team` must be answered on the channel, and the fifteen-second
//      wait must not block it. The conversation continues while the company
//      thinks, which is the entire point of the design.

const REALTIME_URL = 'https://api.openai.com/v1/realtime';

// Calls to this app go through axios, which carries the access token from
// api/chat.js — "sent on every request rather than attached per call, so a new
// endpoint is authenticated by existing". Written with raw fetch, these two
// endpoints returned 401 and the button did nothing.
//
// The SDP exchange below stays on raw fetch, deliberately. That request goes
// to OpenAI, not to this app, and the axios interceptor would attach this
// app's access token to it. A credential for one service must not be posted to
// another.

export function useRealtimeCall({ onTranscript = () => {} } = {}) {
  const [status, setStatus] = useState('idle'); // idle | connecting | live | ending
  const [error, setError] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState('');

  const peerRef = useRef(null);
  const channelRef = useRef(null);
  const streamRef = useRef(null);
  const audioRef = useRef(null);

  const send = useCallback((event) => {
    const channel = channelRef.current;
    if (channel?.readyState === 'open') channel.send(JSON.stringify(event));
  }, []);

  const hangUp = useCallback(() => {
    setStatus('ending');
    // Stop the microphone explicitly. Closing the peer connection alone leaves
    // the browser's recording indicator on, which reads as still listening.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    try { channelRef.current?.close(); } catch { /* already closed */ }
    try { peerRef.current?.close(); } catch { /* already closed */ }
    peerRef.current = null;
    channelRef.current = null;
    streamRef.current = null;
    setSpeaking(false);
    setPendingQuestion('');
    setStatus('idle');
  }, []);

  // The slow path. Deliberately not awaited by the event handler: the
  // conversation has to keep going while the company takes its fifteen
  // seconds, or this is a hold queue rather than a conversation.
  const askTheTeam = useCallback(
    (callId, question) => {
      setPendingQuestion(question);
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: 'Asked. The answer will arrive during this conversation; keep talking until it does.',
        },
      });
      send({ type: 'response.create' });

      axios
        .post('/api/calls/ask', { question })
        .then((res) => res.data.answer)
        .then((answer) => {
          setPendingQuestion('');
          onTranscript({ who: 'team', text: answer });
          send({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [{
                type: 'input_text',
                text:
                  `The team has answered the question you put to them ("${question}"). Tell the founder their ` +
                  `answer has come back, then give it in your own words, briefly, in the language of this ` +
                  `conversation:\n\n${answer}`,
              }],
            },
          });
          send({ type: 'response.create' });
        })
        .catch((err) => {
          setPendingQuestion('');
          // axios reports "Request failed with status code 500", which is the
          // one thing the founder cannot act on. The server's own reason is in
          // the body, and it is what gets spoken.
          const reason = err.response?.data?.error || err.message;
          // Spoken, not swallowed. The founder was told it was being asked, so
          // silence afterwards is a promise broken with no way to notice.
          send({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [{
                type: 'input_text',
                text:
                  `The question you put to the team failed: ${reason}. Tell the founder plainly that it ` +
                  'did not go through, and offer to try again.',
              }],
            },
          });
          send({ type: 'response.create' });
        });
    },
    [send, onTranscript]
  );

  const handleEvent = useCallback(
    (event) => {
      switch (event.type) {
        case 'response.audio.delta':
          setSpeaking(true);
          break;
        case 'response.done': {
          setSpeaking(false);
          for (const item of event.response?.output || []) {
            if (item.type !== 'function_call' || item.name !== 'ask_the_team') continue;
            let args = {};
            try { args = JSON.parse(item.arguments || '{}'); } catch { args = {}; }
            const question = String(args.question || '').trim();
            if (question) askTheTeam(item.call_id, question);
          }
          break;
        }
        case 'input_audio_buffer.speech_started':
          // The founder started talking. The model stops on its own server
          // side, but the indicator has to follow or the page looks stuck.
          setSpeaking(false);
          break;
        case 'conversation.item.input_audio_transcription.completed':
          if (event.transcript) onTranscript({ who: 'you', text: event.transcript.trim() });
          break;
        case 'response.audio_transcript.done':
          if (event.transcript) onTranscript({ who: 'jarvis', text: event.transcript.trim() });
          break;
        case 'error':
          setError(event.error?.message || 'The conversation hit an error.');
          break;
        default:
          break;
      }
    },
    [askTheTeam, onTranscript]
  );

  const start = useCallback(async () => {
    setError('');
    setStatus('connecting');
    try {
      const { data: session } = await axios.post('/api/calls/token');

      const peer = new RTCPeerConnection();
      peerRef.current = peer;

      // Where the model's voice comes out.
      peer.ontrack = (e) => {
        if (audioRef.current) audioRef.current.srcObject = e.streams[0];
      };

      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = mic;
      mic.getTracks().forEach((track) => peer.addTrack(track, mic));

      const channel = peer.createDataChannel('oai-events');
      channelRef.current = channel;
      channel.onmessage = (e) => {
        try { handleEvent(JSON.parse(e.data)); } catch { /* not an event we can read */ }
      };
      channel.onopen = () => {
        setStatus('live');
        // Speak first. Silence on connect reads as a failure, exactly as it
        // does when a phone is answered and nobody says anything.
        if (session.greeting) {
          send({ type: 'response.create', response: { instructions: session.greeting } });
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      const answer = await fetch(`${REALTIME_URL}?model=${encodeURIComponent(session.model)}`, {
        method: 'POST',
        body: offer.sdp,
        headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/sdp' },
      });
      if (!answer.ok) throw new Error(`OpenAI refused the connection (${answer.status}).`);

      await peer.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      hangUp();
    }
  }, [handleEvent, send, hangUp]);

  // A conversation left running when the page closes keeps billing.
  useEffect(() => () => hangUp(), [hangUp]);

  return { status, error, speaking, pendingQuestion, start, hangUp, audioRef };
}
