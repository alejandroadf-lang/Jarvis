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
