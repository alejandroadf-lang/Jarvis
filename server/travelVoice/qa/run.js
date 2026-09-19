#!/usr/bin/env node
// npm run travel:qa [-- --provider ionos --no-judge --only es-pricing,fr-refund]
//
// Runs the advisor against the built-in callers and prints the findings.
// Costs model tokens and nothing else; nothing reaches WhatsApp.

import 'dotenv/config';
import { createAnthropicClient } from '../../agents/anthropicClient.js';
import { runSimulation, formatSummary, SCENARIOS } from './simulate.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] || true;
};

const provider = flag('--provider') || null;
const judge = !args.includes('--no-judge');
const only = flag('--only');
const scenarios = only ? SCENARIOS.filter((s) => String(only).split(',').includes(s.id)) : SCENARIOS;

const anthropic = await createAnthropicClient();
const summary = await runSimulation({ anthropic, provider, judge, scenarios, log: (line) => console.log(line) });
console.log('');
console.log(formatSummary(summary));
if (args.includes('--json')) console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.findings ? 1 : 0;
