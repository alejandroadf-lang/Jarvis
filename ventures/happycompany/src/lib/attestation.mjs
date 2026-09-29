// Signed attestations of an organisation's level for a closed quarter.
//
// A level shown on a page can be retyped into a slide; a signed statement
// cannot be edited without the signature failing. The installation keeps an
// Ed25519 key pair: the private key in the Forge secret store, the public key
// shown to administrators and printed on every attestation. Anyone with the
// attestation file can check it with scripts/verify-attestation.mjs and no
// network access.
//
// What the signature proves, and what it does not: that this installation of
// the app issued exactly this statement. It does not prove the figures are a
// true picture of the organisation (the app sees work-tracking metadata only)
// and it is not a certification. Every attestation says so in its own text,
// because it will be read far from this code.

import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const ATTESTATION_TYPE = 'happycompany.attestation';
export const ATTESTATION_VERSION = 1;
export const STATEMENT =
  'Self-attested by the Happy Company app from Jira or Confluence work metadata at team level. This is not a certification and not an ISO certificate; ' +
  'the levels are Happy Company’s own. Independent verification, for example within an ISO 45001 audit, is recommended.';

/** JSON with keys sorted at every depth, so the same statement always signs to the same bytes. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function newKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

/** A short, stable name for a public key: the first 16 hex of the SHA-256 of its DER form. */
export function keyId(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function signAttestation(payload, privateKeyPem, publicKeyPem) {
  const signature = sign(null, Buffer.from(canonical(payload)), createPrivateKey(privateKeyPem)).toString('base64');
  return { payload, signature, publicKey: publicKeyPem, keyId: keyId(publicKeyPem) };
}

/** {valid, reason}. Checks the signature, the type and version, and that the key id matches the key. */
export function verifyAttestation(att) {
  if (!att || typeof att !== 'object' || !att.payload || !att.signature || !att.publicKey) return { valid: false, reason: 'not an attestation: payload, signature and publicKey are required' };
  if (att.payload.type !== ATTESTATION_TYPE || att.payload.version !== ATTESTATION_VERSION) return { valid: false, reason: `unknown attestation type or version: ${att.payload.type} v${att.payload.version}` };
  let ok;
  try {
    ok = verify(null, Buffer.from(canonical(att.payload)), createPublicKey(att.publicKey), Buffer.from(att.signature, 'base64'));
  } catch (err) {
    return { valid: false, reason: `the key or signature is malformed: ${err.message}` };
  }
  if (!ok) return { valid: false, reason: 'the signature does not match: the statement was changed after it was signed, or signed with another key' };
  if (att.keyId && att.keyId !== keyId(att.publicKey)) return { valid: false, reason: 'the key id does not belong to the public key' };
  return { valid: true, reason: 'signature valid' };
}

/** The statement for one closed quarter's level. Valid until the end of the next quarter. */
export function attestationPayload({ pack, level, product, issuedAt, validUntil }) {
  return {
    type: ATTESTATION_TYPE,
    version: ATTESTATION_VERSION,
    organisation: pack.organisation,
    product,
    quarter: pack.quarter,
    level: level.level,
    levelLabel: level.label,
    criteria: level.criteria.map((c) => ({ key: c.key, level: c.level, met: c.met, value: c.value })),
    figures: {
      teams: pack.scope.teams,
      teamWeeks: pack.scope.teamWeeks,
      sustainableShare: pack.sustainableShare === null ? null : Math.round(pack.sustainableShare * 100) / 100,
      medianWeeksToRecover: pack.medianWeeksToRecover,
      actionCompletion: pack.actions.completion === null ? null : Math.round(pack.actions.completion * 100) / 100,
      pulseTeams: pack.participation.pulseTeams,
      consultationDate: pack.participation.consultationDate,
    },
    methodVersion: pack.methodVersion,
    issuedAt,
    validUntil,
    statement: STATEMENT,
  };
}
