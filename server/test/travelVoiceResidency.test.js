// Where a caller's words may go: the declarations, the guard on every slot,
// and Claude through an EU gateway.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let residency;
let registry;
let llm;
let gateway;
let settings;
let prefs;
const saved = {};
const KEYS = [
  'TRAVEL_VOICE_RESIDENCY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_GATEWAY', 'ANTHROPIC_GATEWAY_REGION', 'ANTHROPIC_GATEWAY_PROJECT',
  'IONOS_API_KEY', 'OPENAI_API_KEY', 'OPENAI_RESIDENCY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_RESIDENCY', 'DEEPGRAM_API_KEY', 'DEEPGRAM_RESIDENCY',
  'ASSEMBLYAI_API_KEY', 'ASSEMBLYAI_RESIDENCY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY',
  'TRAVEL_VOICE_STT_PROVIDER', 'TRAVEL_VOICE_LLM_PROVIDER', 'TRAVEL_VOICE_TTS_PROVIDER', 'TRAVEL_VOICE_JUDGE_MODEL',
];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-residency-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  residency = await import('../travelVoice/residency.js');
  registry = await import('../travelVoice/providers/index.js');
  llm = await import('../travelVoice/providers/llm.js');
  gateway = await import('../agents/anthropicClient.js');
  settings = await import('../travelVoice/settings.js');
  prefs = await import('../travelVoice/providerPrefs.js');
});

after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  settings.__resetSettingsForTests();
  prefs.__resetPrefsForTests();
});

test('a vendor is not EU unless declared, and an EU endpoint in a base URL counts as a declaration', () => {
  assert.equal(residency.declaredResidency('OPENAI_RESIDENCY'), 'us');
  process.env.OPENAI_RESIDENCY = 'eu';
  assert.equal(residency.declaredResidency('OPENAI_RESIDENCY'), 'eu');
  process.env.OPENAI_RESIDENCY = 'mars';
  assert.equal(residency.declaredResidency('OPENAI_RESIDENCY'), 'us', 'nonsense is not EU');
  assert.equal(residency.declaredResidency('X_RESIDENCY', { baseUrl: 'https://api.eu.assemblyai.com/v2' }), 'eu');
  assert.equal(residency.declaredResidency('X_RESIDENCY', { baseUrl: 'https://api.eu.residency.elevenlabs.io' }), 'eu');
  assert.equal(residency.declaredResidency('X_RESIDENCY', { baseUrl: 'https://api.deepgram.com' }), 'us');
  assert.equal(residency.residencyMode(), 'any');
  process.env.TRAVEL_VOICE_RESIDENCY = 'eu';
  assert.equal(residency.residencyMode(), 'eu');
  settings.setOverride('residency', 'any');
  assert.equal(residency.residencyMode(), 'any', 'the phone dial wins');
});

test('with residency eu, only EU-hosted providers answer, and a named one that is not is refused with the reason', () => {
  process.env.ANTHROPIC_API_KEY = 'an';
  process.env.IONOS_API_KEY = 'io';
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ELEVENLABS_API_KEY = 'el';
  assert.equal(registry.resolveProvider('llm').id, 'anthropic', 'any: the first configured');
  assert.equal(registry.resolveProvider('stt').id, 'openai');

  process.env.TRAVEL_VOICE_RESIDENCY = 'eu';
  assert.equal(registry.resolveProvider('llm').id, 'ionos', 'eu: Claude on the direct API is skipped for IONOS');
  assert.equal(registry.resolveProvider('stt'), null, 'no EU-declared ears: nothing, not a US ear');
  assert.throws(() => registry.resolveProvider('llm', 'anthropic'), /Anthropic Claude is not EU-hosted \(global\) and residency is set to eu/);
  assert.throws(() => registry.resolveProvider('stt', 'openai'), /OpenAI Whisper is not EU-hosted \(us\)/);

  // A pin and a deployment default fall through the same way.
  prefs.setOverride('llm', 'openai');
  assert.equal(registry.resolveProvider('llm').id, 'ionos');
  assert.equal(registry.providerSource('llm'), 'first');
  process.env.TRAVEL_VOICE_STT_PROVIDER = 'elevenlabs';
  assert.equal(registry.resolveProvider('stt'), null);

  // Declaring the ElevenLabs account as EU-resident brings it back.
  process.env.ELEVENLABS_RESIDENCY = 'eu';
  assert.equal(registry.resolveProvider('stt').id, 'elevenlabs');
  assert.equal(registry.providerSource('stt'), 'env');

  const described = registry.describeProviders();
  assert.equal(described.residency, 'eu');
  const byId = Object.fromEntries(described.llm.options.map((o) => [o.id, o]));
  assert.deepEqual([byId.ionos.residency, byId.ionos.allowed], ['eu', true]);
  assert.deepEqual([byId.anthropic.residency, byId.anthropic.allowed], ['global', false]);
  assert.equal(byId.deepseek.residency, 'unknown');
});

test('Claude is EU-hosted only through an EU region of Bedrock or Vertex, and Bedrock spells the model its own way', () => {
  process.env.ANTHROPIC_API_KEY = 'an';
  assert.equal(gateway.anthropicGateway(), 'direct');
  assert.equal(gateway.anthropicResidency(), 'global');
  assert.equal(gateway.anthropicConfigured(), true);
  assert.equal(gateway.modelForGateway('claude-opus-5'), 'claude-opus-5');

  process.env.ANTHROPIC_GATEWAY = 'bedrock';
  assert.equal(gateway.anthropicConfigured(), false, 'a region is needed');
  process.env.ANTHROPIC_GATEWAY_REGION = 'eu-central-1';
  assert.equal(gateway.anthropicConfigured(), true);
  assert.equal(gateway.anthropicResidency(), 'eu');
  assert.equal(gateway.modelForGateway('claude-opus-5'), 'anthropic.claude-opus-5');
  assert.equal(gateway.modelForGateway('anthropic.claude-opus-5'), 'anthropic.claude-opus-5', 'not twice');
  assert.match(gateway.describeAnthropicGateway(), /bedrock in eu-central-1 \(eu\)/);
  process.env.ANTHROPIC_GATEWAY_REGION = 'us-east-1';
  assert.equal(gateway.anthropicResidency(), 'us');

  process.env.ANTHROPIC_GATEWAY = 'vertex';
  process.env.ANTHROPIC_GATEWAY_REGION = 'europe-west1';
  assert.equal(gateway.anthropicConfigured(), false, 'a project is needed');
  process.env.ANTHROPIC_GATEWAY_PROJECT = 'my-project';
  assert.equal(gateway.anthropicConfigured(), true);
  assert.equal(gateway.anthropicResidency(), 'eu');
  assert.equal(gateway.modelForGateway('claude-opus-5'), 'claude-opus-5', 'Vertex takes the bare id');

  // Under residency eu, Claude through an EU gateway is allowed, and the brain sends the gateway's model id.
  process.env.ANTHROPIC_GATEWAY = 'bedrock';
  process.env.ANTHROPIC_GATEWAY_REGION = 'eu-west-1';
  process.env.TRAVEL_VOICE_RESIDENCY = 'eu';
  assert.equal(registry.resolveProvider('llm', 'anthropic').id, 'anthropic');
  const seen = [];
  llm.anthropicBrain.create({ max_tokens: 10, messages: [] }, { anthropic: { messages: { create: async (r) => { seen.push(r); return {}; } } } });
  assert.equal(seen[0].model, 'anthropic.claude-opus-5');
});

test('the direct client, the Bedrock client and the Vertex client are all constructible', async () => {
  process.env.ANTHROPIC_API_KEY = 'an';
  const direct = await gateway.createAnthropicClient();
  assert.equal(typeof direct.messages.create, 'function');

  process.env.ANTHROPIC_GATEWAY = 'bedrock';
  await assert.rejects(() => gateway.createAnthropicClient(), /needs ANTHROPIC_GATEWAY_REGION/);
  process.env.ANTHROPIC_GATEWAY_REGION = 'eu-central-1';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test';
  const bedrock = await gateway.createAnthropicClient();
  assert.equal(typeof bedrock.messages.create, 'function');

  process.env.ANTHROPIC_GATEWAY = 'vertex';
  process.env.ANTHROPIC_GATEWAY_REGION = 'europe-west1';
  await assert.rejects(() => gateway.createAnthropicClient(), /needs ANTHROPIC_GATEWAY_REGION .* and ANTHROPIC_GATEWAY_PROJECT/);
  // Constructing the Vertex client starts Google's credential lookup, which
  // has nothing to find here and complains on exit; the package resolving
  // is what this deployment needs to know.
  const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk');
  assert.equal(typeof AnthropicVertex, 'function');
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
});

test('the judge is its own tier, priced and switchable apart from the live model', () => {
  assert.equal(llm.judgeModel(), 'claude-opus-5');
  assert.equal(llm.judgePriceSpec().inputPricePerMTok, 5);
  process.env.TRAVEL_VOICE_JUDGE_MODEL = 'claude-sonnet-5';
  assert.equal(llm.judgeModel(), 'claude-sonnet-5');
  assert.equal(llm.judgePriceSpec().outputPricePerMTok, 10);
});
