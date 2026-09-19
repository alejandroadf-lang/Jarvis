// The one place the Anthropic client is built, and the one place it can be
// pointed at an EU region.
//
// The direct Anthropic API has no EU-only inference geography. Claude in
// the European Union means Claude on Amazon Bedrock in an EU region, or on
// Google Vertex AI in a European one. Both speak the same Messages API
// through their own client classes, so the rest of the app never knows
// which it got — the advisor's brain calls `messages.create` either way.
//
//   ANTHROPIC_GATEWAY=direct   (default) new Anthropic({ apiKey })
//   ANTHROPIC_GATEWAY=bedrock  AnthropicBedrockMantle({ awsRegion })  — AWS credentials from the environment
//   ANTHROPIC_GATEWAY=vertex   AnthropicVertex({ projectId, region })  — Google ADC
//
// with ANTHROPIC_GATEWAY_REGION (eu-central-1, eu-west-1, europe-west1,
// europe-west4 …) and, for Vertex, ANTHROPIC_GATEWAY_PROJECT. Whether the
// result counts as EU-hosted is decided from the region name, and that is
// what the residency guard reads.

import Anthropic from '@anthropic-ai/sdk';

export function anthropicGateway() {
  const raw = (process.env.ANTHROPIC_GATEWAY || '').trim().toLowerCase();
  return ['bedrock', 'vertex'].includes(raw) ? raw : 'direct';
}

export function anthropicGatewayRegion() {
  return (process.env.ANTHROPIC_GATEWAY_REGION || '').trim();
}

/** Where Claude runs for this deployment: 'eu', 'us' or 'global'. */
export function anthropicResidency() {
  const gateway = anthropicGateway();
  if (gateway === 'direct') return 'global';
  const region = anthropicGatewayRegion().toLowerCase();
  if (/^(eu|europe)\b|^(eu|europe)-/.test(region)) return 'eu';
  if (/^(us|northamerica)\b|^us-/.test(region)) return 'us';
  return 'unknown';
}

/**
 * The model id as the gateway spells it. Bedrock prefixes the vendor;
 * Vertex and the direct API take the bare id.
 */
export function modelForGateway(model) {
  if (anthropicGateway() === 'bedrock' && !/^anthropic\./.test(model)) return `anthropic.${model}`;
  return model;
}

/** Whether the credentials for the configured gateway are in place. */
export function anthropicConfigured() {
  const gateway = anthropicGateway();
  if (gateway === 'direct') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (gateway === 'bedrock') return Boolean(anthropicGatewayRegion());
  return Boolean(anthropicGatewayRegion() && (process.env.ANTHROPIC_GATEWAY_PROJECT || process.env.GOOGLE_CLOUD_PROJECT));
}

/**
 * Builds the client for the configured gateway. Async because the Bedrock
 * and Vertex clients are separate packages, loaded only when asked for,
 * so a deployment on the direct API carries neither.
 */
export async function createAnthropicClient() {
  const gateway = anthropicGateway();
  if (gateway === 'bedrock') {
    const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk');
    const awsRegion = anthropicGatewayRegion();
    if (!awsRegion) throw new Error('ANTHROPIC_GATEWAY=bedrock needs ANTHROPIC_GATEWAY_REGION (for example eu-central-1)');
    return new AnthropicBedrockMantle({ awsRegion });
  }
  if (gateway === 'vertex') {
    const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk');
    const region = anthropicGatewayRegion();
    const projectId = (process.env.ANTHROPIC_GATEWAY_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '').trim();
    if (!region || !projectId) throw new Error('ANTHROPIC_GATEWAY=vertex needs ANTHROPIC_GATEWAY_REGION (for example europe-west1) and ANTHROPIC_GATEWAY_PROJECT');
    return new AnthropicVertex({ projectId, region });
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/** A line for the status panel. */
export function describeAnthropicGateway() {
  const gateway = anthropicGateway();
  if (gateway === 'direct') return 'direct API (no EU-only inference geography)';
  return `${gateway} in ${anthropicGatewayRegion() || 'an unset region'} (${anthropicResidency()})`;
}
