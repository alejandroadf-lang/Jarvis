#!/usr/bin/env node
// Check a Happy Company attestation offline.
//
//   node scripts/verify-attestation.mjs attestation.json [expected-key-id]
//
// Give the key id the organisation shows on its organisation page to be sure
// the attestation came from that installation and not from another one: a
// valid signature alone only proves the file was not changed after signing.
import { readFileSync } from 'node:fs';
import { verifyAttestation } from '../src/lib/attestation.mjs';

const [file, expectedKeyId] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/verify-attestation.mjs attestation.json [expected-key-id]');
  process.exit(2);
}
let att;
try {
  att = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`cannot read ${file}: ${err.message}`);
  process.exit(2);
}
const result = verifyAttestation(att);
if (result.valid && expectedKeyId && att.keyId !== expectedKeyId) {
  result.valid = false;
  result.reason = `signed with key ${att.keyId}, not the expected ${expectedKeyId}`;
}
if (!result.valid) {
  console.error(`INVALID: ${result.reason}`);
  process.exit(1);
}
const p = att.payload;
console.log(`VALID (key ${att.keyId})`);
console.log(`${p.organisation || 'Organisation not named'}, ${p.product}, ${p.quarter}: ${p.levelLabel}. Issued ${p.issuedAt.slice(0, 10)}, valid until ${p.validUntil}.`);
if (p.validUntil < new Date().toISOString().slice(0, 10)) console.log('Note: this attestation has expired.');
console.log(p.statement);
