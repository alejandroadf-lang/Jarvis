// Just enough Ogg Opus to answer two questions without a media library:
// how long is this voice note, and can a comment be written into it.
//
// A WhatsApp voice note is Opus in an Ogg container. Ogg is a sequence of
// pages; each page starts with "OggS", carries a 64-bit granule position
// (for Opus, the count of 48 kHz samples up to the end of the page) and a
// segment table that says how long the page is. The first packet is an
// OpusHead with a pre-skip count that the granule position includes. So the
// duration is the last page's granule position, less the pre-skip, over
// 48000 — read from the file itself, before any transcriber has been paid
// to look at it.

const SAMPLE_RATE = 48000;

/**
 * Walks the pages of an Ogg stream, calling back with each one.
 * Stops at the first page that does not parse.
 */
export function* oggPages(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  let offset = 0;
  while (offset + 27 <= buf.length) {
    if (buf.toString('latin1', offset, offset + 4) !== 'OggS') break;
    const headerType = buf[offset + 5];
    const granule = buf.readBigInt64LE(offset + 6);
    const serial = buf.readUInt32LE(offset + 14);
    const sequence = buf.readUInt32LE(offset + 18);
    const segments = buf[offset + 26];
    const tableEnd = offset + 27 + segments;
    if (tableEnd > buf.length) break;
    let bodyLength = 0;
    for (let i = 0; i < segments; i++) bodyLength += buf[offset + 27 + i];
    const end = tableEnd + bodyLength;
    if (end > buf.length) break;
    yield {
      offset,
      end,
      headerType,
      granule,
      serial,
      sequence,
      segments,
      body: buf.subarray(tableEnd, end),
      segmentTable: buf.subarray(offset + 27, tableEnd),
    };
    offset = end;
  }
}

/** The pre-skip from an OpusHead packet, or 0 when the page is not one. */
function preSkipOf(page) {
  if (page.body.toString('latin1', 0, 8) !== 'OpusHead') return null;
  return page.body.length >= 12 ? page.body.readUInt16LE(10) : 0;
}

/**
 * Seconds of audio in an Ogg Opus file, or null when it is not one.
 *
 * Null rather than a guess, because the one thing this is used for —
 * deciding whether a clip is too short to trust its language — must not
 * be decided by a byte-length estimate of a file that turned out to be
 * something else.
 */
export function oggOpusDurationSeconds(buffer) {
  let preSkip = null;
  let lastGranule = null;
  let sawOpus = false;
  for (const page of oggPages(buffer)) {
    const skip = preSkipOf(page);
    if (skip !== null) {
      sawOpus = true;
      preSkip = skip;
      continue;
    }
    // Header pages (OpusTags) carry a granule of zero; the first audio page
    // is already past the pre-skip. So zero is "not audio", not "empty".
    if (page.granule > 0n) lastGranule = page.granule;
  }
  if (!sawOpus || lastGranule === null) return null;
  const samples = Number(lastGranule) - (preSkip || 0);
  return samples > 0 ? samples / SAMPLE_RATE : 0;
}

/** True when the bytes begin like an Ogg stream. */
export function isOgg(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  return buf.length >= 4 && buf.toString('latin1', 0, 4) === 'OggS';
}

export const __testing = { SAMPLE_RATE };

// --- writing a comment into the stream --------------------------------------------

// The Ogg page checksum: CRC-32 with polynomial 0x04c11db7, no reflection,
// no initial value and no final XOR, computed over the whole page with the
// checksum bytes zeroed. Not the CRC-32 of zlib, which reflects both ways.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggChecksum(page) {
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc >>> 0;
}

function lacing(length) {
  const segments = [];
  let left = length;
  while (left >= 255) { segments.push(255); left -= 255; }
  segments.push(left); // a body that is an exact multiple of 255 ends in a zero segment
  return segments;
}

function buildPage({ headerType, granule, serial, sequence, body }) {
  const segments = lacing(body.length);
  const header = Buffer.alloc(27 + segments.length);
  header.write('OggS', 0, 'latin1');
  header[4] = 0;
  header[5] = headerType;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header.writeUInt32LE(0, 22);
  header[26] = segments.length;
  segments.forEach((n, i) => { header[27 + i] = n; });
  const page = Buffer.concat([header, body]);
  page.writeUInt32LE(oggChecksum(page), 22);
  return page;
}

/** The comments in an Ogg Opus stream's OpusTags packet, as KEY=value strings. */
export function oggOpusComments(buffer) {
  for (const page of oggPages(buffer)) {
    if (page.body.toString('latin1', 0, 8) !== 'OpusTags') continue;
    const body = page.body;
    let at = 8;
    const vendorLength = body.readUInt32LE(at); at += 4 + vendorLength;
    const count = body.readUInt32LE(at); at += 4;
    const comments = [];
    for (let i = 0; i < count && at + 4 <= body.length; i++) {
      const length = body.readUInt32LE(at); at += 4;
      comments.push(body.toString('utf8', at, at + length)); at += length;
    }
    return comments;
  }
  return null;
}

/**
 * Returns the same stream with comments added to its OpusTags packet, or
 * the stream unchanged when it has no such packet to add them to.
 *
 * The comment page is rebuilt (new body, new lacing, new checksum); every
 * other page is copied byte for byte, so the audio is untouched and the
 * page sequence still counts up without a gap. This is how a synthesised
 * voice note carries a machine-readable "this is AI" inside the file, as
 * Article 50 asks for, in the one place a container has for it.
 */
export function tagOggOpus(buffer, comments) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!isOgg(buf) || !comments?.length) return buf;
  const parts = [];
  let tagged = false;
  let last = 0;
  for (const page of oggPages(buf)) {
    if (!tagged && page.body.toString('latin1', 0, 8) === 'OpusTags') {
      const body = page.body;
      let at = 8;
      const vendorLength = body.readUInt32LE(at);
      const head = body.subarray(0, at + 4 + vendorLength);
      at += 4 + vendorLength;
      const count = body.readUInt32LE(at);
      const existing = body.subarray(at + 4);
      const added = comments.map((c) => {
        const text = Buffer.from(String(c), 'utf8');
        const len = Buffer.alloc(4);
        len.writeUInt32LE(text.length, 0);
        return Buffer.concat([len, text]);
      });
      const newCount = Buffer.alloc(4);
      newCount.writeUInt32LE(count + comments.length, 0);
      const newBody = Buffer.concat([head, newCount, existing, ...added]);
      parts.push(buf.subarray(last, page.offset));
      parts.push(buildPage({ headerType: page.headerType, granule: page.granule, serial: page.serial, sequence: page.sequence, body: newBody }));
      last = page.end;
      tagged = true;
    }
  }
  if (!tagged) return buf;
  parts.push(buf.subarray(last));
  return Buffer.concat(parts);
}
