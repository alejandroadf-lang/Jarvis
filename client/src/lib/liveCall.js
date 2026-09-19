// A live call from the browser: microphone up, the advisor's voice down.
//
// The server half (server/travelVoice/live/) owns everything hard —
// deciding when you have stopped talking, stopping dead when you talk over
// the answer, the advisor itself. This end has three jobs and should have
// no opinions beyond them:
//
//   1. Capture the microphone as PCM16 at 16 kHz and send it, frame by
//      frame, as it arrives. An AudioContext opened at 16 kHz does the
//      resampling in the browser, which is both better and free.
//
//   2. Play what comes back, and SAY WHEN IT HAS FINISHED. That
//      acknowledgement is the one thing here that is easy to leave out and
//      breaks everything: without it the server goes back to listening
//      while you are still hearing the answer, and every reply interrupts
//      itself.
//
//   3. Stop the audio instantly when told to, because you have started
//      talking and the server has already thrown the rest away.
//
// Echo cancellation is asked for on the microphone and genuinely matters:
// without it the advisor's own voice comes back in and is heard as you
// interrupting. The server holds barge-in to a higher bar as a second line
// of defence, but the browser is where this is actually solved.

const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const SAMPLE_RATE = 16000;

// An AudioWorklet has to be a separate module loaded by URL. Rather than
// ship an asset and teach the bundler about it, the source is right here
// and handed over as a blob — it is fifteen lines and belongs next to the
// code that reads its output.
const PROCESSOR = `
class Pcm16Frames extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(${FRAME_SAMPLES});
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm16-frames', Pcm16Frames);
`;

function socketUrl({ sessionId, number, language, providers = {} }) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${window.location.host}/api/travel-voice/live`);
  url.searchParams.set('sessionId', sessionId);
  if (number) url.searchParams.set('number', number);
  if (language) url.searchParams.set('language', language);
  for (const [slot, id] of Object.entries(providers)) if (id) url.searchParams.set(slot, id);
  return url.toString();
}

/**
 * Starts a call. Returns a handle with `hangUp()`; everything else arrives
 * through `onEvent`, which gets the server's messages plus a few of this
 * end's own (`mic-denied`, `closed`).
 *
 * @param {object} options
 * @param {(event: object) => void} options.onEvent
 */
export async function startLiveCall({ sessionId, number = null, language = null, providers = {}, onEvent = () => {} } = {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    onEvent({ type: 'mic-denied', detail: err.message });
    throw err;
  }

  const audio = new AudioContext({ sampleRate: SAMPLE_RATE });
  const worklet = URL.createObjectURL(new Blob([PROCESSOR], { type: 'application/javascript' }));
  await audio.audioWorklet.addModule(worklet);
  URL.revokeObjectURL(worklet);

  const socket = new WebSocket(socketUrl({ sessionId, number, language, providers }));
  socket.binaryType = 'arraybuffer';

  const source = audio.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audio, 'pcm16-frames');
  node.port.onmessage = ({ data }) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data.buffer);
  };
  source.connect(node);
  // A worklet with nowhere to go is suspended by some browsers, and a zero
  // gain keeps the microphone out of the speaker while keeping it alive.
  const silent = audio.createGain();
  silent.gain.value = 0;
  node.connect(silent).connect(audio.destination);

  let playing = null;
  let closed = false;

  function stopPlaying() {
    if (!playing) return;
    try {
      playing.onended = null;
      playing.stop();
    } catch {
      // Already finished.
    }
    playing = null;
  }

  async function play(message) {
    const bytes = Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0));
    let buffer;
    try {
      buffer = await audio.decodeAudioData(bytes.buffer);
    } catch (err) {
      // Nothing to play means nothing to wait for; tell the server or the
      // call sits in silence for ever.
      onEvent({ type: 'error', detail: `Could not decode the reply: ${err.message}` });
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'played' }));
      return;
    }
    stopPlaying();
    const node2 = audio.createBufferSource();
    node2.buffer = buffer;
    node2.connect(audio.destination);
    node2.onended = () => {
      if (playing === node2) playing = null;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'played' }));
    };
    playing = node2;
    node2.start();
  }

  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    // The server has thrown the rest of the answer away; stop making noise.
    if (message.type === 'interrupt') stopPlaying();
    if (message.type === 'audio') play(message);
    onEvent(message);
  };

  const teardown = (reason) => {
    if (closed) return;
    closed = true;
    stopPlaying();
    try { node.port.onmessage = null; node.disconnect(); source.disconnect(); } catch { /* already torn down */ }
    for (const track of stream.getTracks()) track.stop();
    audio.close().catch(() => {});
    onEvent({ type: 'closed', reason });
  };

  socket.onclose = () => teardown('closed');
  socket.onerror = () => onEvent({ type: 'error', detail: 'The connection dropped.' });

  return {
    hangUp() {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'bye' }));
      try { socket.close(); } catch { /* already closing */ }
      teardown('hung-up');
    },
    get state() {
      return closed ? 'closed' : socket.readyState === WebSocket.OPEN ? 'open' : 'connecting';
    },
  };
}

/** Whether this browser can take a live call at all. */
export function liveCallSupported() {
  return Boolean(
    typeof window !== 'undefined' &&
      window.AudioContext &&
      window.AudioWorkletNode &&
      navigator?.mediaDevices?.getUserMedia &&
      window.WebSocket
  );
}
