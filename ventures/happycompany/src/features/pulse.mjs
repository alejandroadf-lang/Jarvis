// Storing and serving the anonymous team pulse. The design and its privacy
// guarantees are described in src/lib/pulse.mjs.

import { createHash } from 'node:crypto';
import { itemsFor, periodOf, previousPeriod, validateResponse, emptyTally, addToTally, publicResults } from '../lib/pulse.mjs';

export const TALLY_RETAIN_PERIODS = 36; // three years of monthly pulses: evidence for ISO 45001 5.4

export function createPulse({ store, now, salt, audit }) {
  const tallyKey = (scope, period) => `pulse:${scope}:${period}`;
  const votedKey = (scope, period) => `pulsevoted:${scope}:${period}`;

  // A code for "this person has answered this period", unlinkable to the
  // activity pseudonyms and to other periods: the key mixes in the period.
  async function voterCode(scope, period, accountId) {
    return createHash('sha256').update(`${await salt()}:pulse:${scope}:${period}:${accountId}`).digest('hex').slice(0, 20);
  }

  async function state({ scope, settings, today, minGroup, accountId }) {
    const cadence = settings.pulse === 'monthly' || settings.pulse === 'quarterly' ? settings.pulse : 'off';
    if (cadence === 'off') return { cadence };
    const items = itemsFor({ validation: settings.validation === true });
    const period = periodOf(today, cadence);
    const current = (await store.get(tallyKey(scope, period))) || emptyTally();
    const voted = (await store.get(votedKey(scope, period))) || [];
    const answered = accountId ? voted.includes(await voterCode(scope, period, accountId)) : false;
    const closedPeriod = previousPeriod(period);
    const closed = await store.get(tallyKey(scope, closedPeriod));
    return {
      cadence,
      period,
      items,
      answered,
      answersSoFar: current.n,
      closedPeriod,
      results: publicResults(closed, items, minGroup),
      minGroup,
    };
  }

  async function respond({ scope, settings, today, accountId, answers }) {
    const cadence = settings.pulse === 'monthly' || settings.pulse === 'quarterly' ? settings.pulse : 'off';
    if (cadence === 'off') throw new Error('The team pulse is not switched on for this team.');
    if (!accountId) throw new Error('Sign in to answer the pulse.');
    const items = itemsFor({ validation: settings.validation === true });
    const clean = validateResponse(answers, items);
    const period = periodOf(today, cadence);
    const code = await voterCode(scope, period, accountId);
    const voted = (await store.get(votedKey(scope, period))) || [];
    if (voted.includes(code)) throw new Error('You have already answered this period’s pulse. Thank you.');
    voted.push(code);
    await store.set(votedKey(scope, period), voted);
    const tally = (await store.get(tallyKey(scope, period))) || emptyTally();
    await store.set(tallyKey(scope, period), addToTally(tally, clean));
    // The audit trail records that the pulse was answered, never by whom or how.
    await audit(scope, 'pulse.answer', { period });
    return { period, answersSoFar: tally.n };
  }

  /** Tallies of closed periods, for validation and the evidence pack. */
  async function closedTally(scope, settings, today) {
    const cadence = settings.pulse === 'monthly' || settings.pulse === 'quarterly' ? settings.pulse : null;
    if (!cadence) return null;
    const period = previousPeriod(periodOf(today, cadence));
    const tally = await store.get(tallyKey(scope, period));
    return tally ? { period, tally } : null;
  }

  /** Voter lists of past periods serve no purpose and are deleted. */
  async function expire(scope, settings, today) {
    const cadence = settings.pulse === 'quarterly' ? 'quarterly' : 'monthly';
    const period = periodOf(today, cadence);
    let deleted = 0;
    for (const { key } of await store.list(`pulsevoted:${scope}:`)) {
      if (key.slice(`pulsevoted:${scope}:`.length) !== period) {
        await store.delete(key);
        deleted += 1;
      }
    }
    const tallies = (await store.list(`pulse:${scope}:`)).map((r) => r.key).sort();
    for (const key of tallies.slice(0, Math.max(0, tallies.length - TALLY_RETAIN_PERIODS))) {
      await store.delete(key);
      deleted += 1;
    }
    return deleted;
  }

  return { state, respond, closedTally, expire };
}
