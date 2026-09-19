// PCM in, a file the transcribers accept out.
//
// A live call arrives as a stream of raw samples; every speech-to-text API
// here wants a file with a header on it. A WAV header is 44 bytes and no
// dependency, which is the whole reason this exists rather than reaching
// for a media library: the alternative is encoding Opus in-process, and
// the difference in upload size for a ten-second utterance does not pay
// for that.

const HEADER_BYTES = 44;

/**
 * Wraps raw PCM16 little-endian mono samples in a WAV container.
 *
 * @param {Buffer|Int16Array|Buffer[]} pcm one buffer, or the frames as they arrived
 * @param {{sampleRate?: number, channels?: number}} [opts]
 */
export function pcmToWav(pcm, { sampleRate = 16000, channels = 1 } = {}) {
  const body = Array.isArray(pcm) ? Buffer.concat(pcm.map(asBuffer)) : asBuffer(pcm);
  const header = Buffer.alloc(HEADER_BYTES);
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + body.length, 4); // everything after this field
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM, uncompressed
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(body.length, 40);

  return Buffer.concat([header, body]);
}

function asBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Int16Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(chunk || []);
}

/** Seconds of audio in a PCM16 buffer at a given rate. */
export function pcmSeconds(pcm, { sampleRate = 16000, channels = 1 } = {}) {
  const bytes = Array.isArray(pcm) ? pcm.reduce((total, c) => total + asBuffer(c).length, 0) : asBuffer(pcm).length;
  return bytes / 2 / channels / sampleRate;
}

/** Reads a WAV back, for tests and for anything that needs the samples again. */
export function wavToPcm(wav) {
  const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav || []);
  if (buf.length < HEADER_BYTES || buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  // Walk the chunks rather than assuming data starts at 44: a file written
  // by something else may carry a LIST chunk first.
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') return { pcm: buf.subarray(at + 8, at + 8 + size), sampleRate, channels };
    at += 8 + size + (size % 2);
  }
  return null;
}
