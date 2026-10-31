// The Graph API version is current, can be moved from Railway, and a typo cannot break every message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphVersion, GRAPH_API } from '../channels/whatsapp.js';

test('the default is the current version, no longer the one Meta removes on 21 January 2027', () => {
  assert.equal(graphVersion({}), 'v26.0');
  assert.doesNotMatch(GRAPH_API, /v21\.0/);
  assert.match(GRAPH_API, /^https:\/\/graph\.facebook\.com\/v\d+\.\d+$/);
});

test('a version can be set, and anything that is not one is ignored', () => {
  assert.equal(graphVersion({ WHATSAPP_GRAPH_VERSION: ' v27.0 ' }), 'v27.0');
  assert.equal(graphVersion({ WHATSAPP_GRAPH_VERSION: 'latest' }), 'v26.0');
  assert.equal(graphVersion({ WHATSAPP_GRAPH_VERSION: '26' }), 'v26.0');
  assert.equal(graphVersion({ WHATSAPP_GRAPH_VERSION: 'v26.0/../admin' }), 'v26.0');
  assert.equal(graphVersion({ WHATSAPP_GRAPH_VERSION: '' }), 'v26.0');
});
