// Reading the length of an Ogg Opus voice note from its pages, so a clip too
// short to trust its language can be recognised before any transcriber has
// been paid to hear it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oggOpusDurationSeconds, oggPages, isOgg } from '../travelVoice/ogg.js';

// A minimal Ogg page: header, one segment table entry, the body.
function page({ granule, body, headerType = 0, serial = 1, sequence = 0 }) {
  const segments = [];
  let left = body.length;
  while (left >= 255) { segments.push(255); left -= 255; }
  segments.push(left);
  const header = Buffer.alloc(27 + segments.length);
  header.write('OggS', 0, 'latin1');
  header[4] = 0;
  header[5] = headerType;
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header.writeUInt32LE(0, 22); // checksum, not verified here
  header[26] = segments.length;
  segments.forEach((n, i) => { header[27 + i] = n; });
  return Buffer.concat([header, body]);
}

function opusHead(preSkip) {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'latin1');
  b[8] = 1; // version
  b[9] = 1; // channels
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12);
  return b;
}

export function fakeOpus(seconds, { preSkip = 312 } = {}) {
  const head = page({ granule: 0, body: opusHead(preSkip), headerType: 2, sequence: 0 });
  const tags = page({ granule: 0, body: Buffer.from('OpusTags\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000', 'latin1'), sequence: 1 });
  const audio = page({ granule: Math.round(seconds * 48000) + preSkip, body: Buffer.alloc(40, 1), headerType: 4, sequence: 2 });
  return Buffer.concat([head, tags, audio]);
}

test('the duration is the last granule less the pre-skip, at 48 kHz', () => {
  assert.equal(oggOpusDurationSeconds(fakeOpus(3.5)), 3.5);
  assert.equal(oggOpusDurationSeconds(fakeOpus(1.2, { preSkip: 0 })), 1.2);
  assert.equal([...oggPages(fakeOpus(2))].length, 3);
});

test('anything that is not Ogg Opus reports no duration rather than a guess', () => {
  assert.equal(oggOpusDurationSeconds(Buffer.from('ID3 not ogg at all')), null);
  assert.equal(oggOpusDurationSeconds(Buffer.alloc(0)), null);
  assert.equal(isOgg(fakeOpus(1)), true);
  assert.equal(isOgg(Buffer.from('RIFF')), false);
  // An Ogg stream that is not Opus (no OpusHead) has no known sample rate.
  const vorbisish = Buffer.concat([page({ granule: 0, body: Buffer.from('vorbis'), headerType: 2 }), page({ granule: 96000, body: Buffer.alloc(10) })]);
  assert.equal(oggOpusDurationSeconds(vorbisish), null);
});

test('a truncated file yields the pages that are whole and stops', () => {
  const whole = fakeOpus(4);
  const cut = whole.subarray(0, whole.length - 10);
  assert.equal([...oggPages(cut)].length, 2, 'the torn last page is not returned');
  assert.equal(oggOpusDurationSeconds(cut), null, 'and without it there is no duration');
});
