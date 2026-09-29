// The commit-and-close loop.
//
// Every week the page suggests three changes. A suggestion nobody picks is a
// lecture; a suggestion a team picks, and says a week later whether it did,
// is a habit. Glint's focus areas and 15Five's check-ins work this way, and
// the action-completion rate this produces is the adoption metric the
// organisation view and the evidence pack report (ISO 45001 6.1.4 planning
// action, 10.3 continual improvement).
//
// Actions belong to the team: anyone who can see the team page can commit or
// close, nobody is recorded as the one who did, and HR cannot assign them.

import { isoWeek, previousWeeks } from '../lib/time.mjs';
import { canFreeze } from '../lib/badges.mjs';

export const MAX_COMMITTED = 3;
export const CLOSE_WINDOW_WEEKS = 3;

export function createActions({ store, now, audit = async () => {} }) {
  const key = (scope, week) => `actions:${scope}:${week}`;

  async function get(scope, week) {
    return (await store.get(key(scope, week))) || { week, items: [] };
  }

  /** Commit to some of this week's suggestions. `suggested` is the card's action list. */
  async function commit({ scope, week, keys, suggested }) {
    const wanted = [...new Set(Array.isArray(keys) ? keys : [])];
    if (!wanted.length) throw new Error('Pick at least one of this week’s suggestions.');
    const byKey = Object.fromEntries((suggested || []).map((a) => [a.key, a]));
    const unknown = wanted.filter((k) => !byKey[k]);
    if (unknown.length) throw new Error('Only this week’s suggestions can be committed.');
    const record = await get(scope, week);
    const already = new Set(record.items.map((i) => i.key));
    for (const k of wanted) {
      if (already.has(k)) continue;
      if (record.items.length >= MAX_COMMITTED) throw new Error(`A team commits to at most ${MAX_COMMITTED} things a week.`);
      const a = byKey[k];
      record.items.push({ key: k, label: a.label, text: a.text, action: a.action, committedAt: now().toISOString(), done: null });
    }
    await store.set(key(scope, week), record);
    await audit(scope, 'actions.commit', { week, keys: wanted });
    return record;
  }

  /** Say whether a committed action happened. Allowed for this week and the three before. */
  async function close({ scope, week, key: actionKey, done, thisWeek }) {
    const allowed = [thisWeek, ...previousWeeks(thisWeek, CLOSE_WINDOW_WEEKS)];
    if (!allowed.includes(week)) throw new Error('Actions can be closed for up to three weeks after they were committed.');
    const record = await get(scope, week);
    const item = record.items.find((i) => i.key === actionKey);
    if (!item) throw new Error('That action was not committed that week.');
    item.done = Boolean(done);
    item.closedAt = now().toISOString();
    await store.set(key(scope, week), record);
    await audit(scope, 'actions.close', { week, key: actionKey, done: item.done });
    return record;
  }

  /** {week: {committed, done, open, items}} for the given weeks. */
  async function history(scope, weeks) {
    const out = {};
    for (const week of weeks) {
      const record = await store.get(key(scope, week));
      if (!record?.items?.length) continue;
      const done = record.items.filter((i) => i.done === true).length;
      const open = record.items.filter((i) => i.done === null).length;
      out[week] = { committed: record.items.length, done, open, items: record.items };
    }
    return out;
  }

  /** Completion rate over closed actions in the given history. Null with nothing closed. */
  function completion(hist) {
    let closed = 0;
    let done = 0;
    let committed = 0;
    for (const h of Object.values(hist)) {
      committed += h.committed;
      done += h.done;
      closed += h.committed - h.open;
    }
    return { committed, done, closed, rate: closed ? done / closed : null };
  }

  async function freezes(scope) {
    return (await store.get(`freeze:${scope}`)) || [];
  }

  /** Mark a week as a launch or incident week: it neither breaks nor extends an action streak. */
  async function freeze({ scope, week }) {
    const list = await freezes(scope);
    const recent = [week, ...previousWeeks(week, 12)];
    if (!canFreeze(list, week, recent)) throw new Error('A team can mark at most two weeks a quarter as launch or incident weeks.');
    list.push(week);
    await store.set(`freeze:${scope}`, list.slice(-26));
    await audit(scope, 'actions.freeze', { week });
    return list;
  }

  return { get, commit, close, history, completion, freezes, freeze, currentWeek: (day) => isoWeek(day) };
}
