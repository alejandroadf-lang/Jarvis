// The founder's fastest way to explain something is a screenshot — a
// settings page, an error, a competitor's pricing. The company could not see
// one: extractMessage read text and audio, and anything else got "I can only
// read text messages right now."
//
// So the channel the founder actually reaches for was closed to the team
// that works for them.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let wa;
const savedFetch = global.fetch;
const savedToken = process.env.WHATSAPP_TOKEN;

before(async () => {
  process.env.WHATSAPP_TOKEN = 'test-token';
  wa = await import('../channels/whatsapp.js');
});

after(() => {
  global.fetch = savedFetch;
  if (savedToken === undefined) delete process.env.WHATSAPP_TOKEN;
  else process.env.WHATSAPP_TOKEN = savedToken;
});

beforeEach(() => {
  global.fetch = savedFetch;
});

function envelope(message) {
  return { entry: [{ changes: [{ value: { messages: [message] } }] }] };
}

test('an image is recognised and carries its media id', () => {
  const msg = wa.extractMessage(
    envelope({ id: 'wamid.1', from: '4477', type: 'image', image: { id: 'media-9', mime_type: 'image/png' } })
  );
  assert.equal(msg.type, 'image');
  assert.equal(msg.mediaId, 'media-9');
  assert.equal(wa.isImage(msg), true);
});

test('the caption becomes the message text', () => {
  // "Is this the right setting?" over a screenshot — the caption is the
  // actual question, and everything downstream already handles text.
  const msg = wa.extractMessage(
    envelope({
      id: 'wamid.2',
      from: '4477',
      type: 'image',
      image: { id: 'media-9', caption: 'is this the right scope?' },
    })
  );
  assert.equal(msg.text, 'is this the right scope?');
});

test('an image with no caption still reaches the team as an image', () => {
  // The caption is optional; the picture is the message. A missing caption
  // must not make this look like an empty send.
  const msg = wa.extractMessage(
    envelope({ id: 'wamid.3', from: '4477', type: 'image', image: { id: 'media-9' } })
  );
  assert.equal(msg.text, '');
  assert.equal(wa.isImage(msg), true, 'the caller supplies the prompt, not extractMessage');
});

test('a voice note is untouched by any of this', () => {
  const msg = wa.extractMessage(
    envelope({ id: 'wamid.4', from: '4477', type: 'audio', audio: { id: 'media-3' } })
  );
  assert.equal(msg.mediaId, 'media-3');
  assert.equal(wa.isImage(msg), false);
});

test('downloadMedia returns the real media type, not a guess', async () => {
  // Guessing jpeg for a png is a rejected API request, not a blurry picture.
  global.fetch = async (url) =>
    String(url).includes('media-9')
      ? { ok: true, json: async () => ({ url: 'https://cdn/x', mime_type: 'image/png' }) }
      : { ok: true, arrayBuffer: async () => new TextEncoder().encode('PNGDATA').buffer };

  const { buffer, mimeType } = await wa.downloadMedia('media-9');
  assert.equal(mimeType, 'image/png');
  assert.equal(buffer.toString(), 'PNGDATA');
});

test('the supported list is what the model can actually read', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
    assert.ok(wa.SUPPORTED_IMAGE_TYPES.includes(type));
  }
  assert.ok(!wa.SUPPORTED_IMAGE_TYPES.includes('image/heic'), 'heic would be accepted and then rejected');
});

test('the unsupported reply no longer claims text is all we read', () => {
  // It said "I can only read text messages right now" long after voice notes
  // worked. A capability message that is out of date teaches the founder not
  // to try things that would have worked.
  const reply = wa.unsupportedTypeReply('document');
  assert.match(reply, /text, voice notes and images/i);
  assert.match(wa.unsupportedTypeReply('image'), /JPEG, PNG/);
});
