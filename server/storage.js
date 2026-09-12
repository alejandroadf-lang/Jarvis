// Is the data directory actually persisting?
//
// This exists because of a failure nobody could see. The company's entire
// memory — ledger, ventures, conversation history, the action log, daily
// reports — lives as JSON files under JARVIS_DATA_DIR. On a container host
// that directory is wiped on every redeploy unless a volume is mounted at
// it, and nothing said so. The founder discovered it by noticing a record
// had vanished, days after it started happening.
//
// Detection is the interesting part, because "is this directory persistent"
// cannot be answered by looking at it. What can be answered is "has anything
// here survived a restart", which is the question that actually matters. So
// the app leaves a mark on every boot and counts how many marks it finds. A
// counter that is still 1 after a redeploy is proof the directory was
// emptied; a counter above 1 is proof it was not.

import { readJson, writeJson } from './store.js';

const FILE = 'storage.json';

/**
 * Records this boot and returns what the count implies. Called once at
 * startup, and never throws: a diagnostic that can take the server down is
 * worse than the problem it reports.
 */
export function recordBoot() {
  try {
    const now = new Date().toISOString();
    const data = readJson(FILE, { firstSeenAt: now, lastSeenAt: now, boots: 0 });
    data.boots = (data.boots || 0) + 1;
    data.lastSeenAt = now;
    if (!data.firstSeenAt) data.firstSeenAt = now;
    writeJson(FILE, data);
    return data;
  } catch (err) {
    console.error('Storage check failed:', err.message);
    return null;
  }
}

export function getStorageStatus() {
  const dirConfigured = Boolean((process.env.JARVIS_DATA_DIR || '').trim());
  let data;
  try {
    data = readJson(FILE, { firstSeenAt: null, lastSeenAt: null, boots: 0 });
  } catch (err) {
    return {
      dirConfigured,
      persistent: false,
      boots: 0,
      detail: `Cannot read the data directory: ${err.message}`,
    };
  }

  const boots = data.boots || 0;

  if (!dirConfigured) {
    // Locally this is fine — it's server/data next to the code. On a
    // container host it is the writable layer, which is discarded on every
    // deploy. The app can't tell which it is on, so it says what it depends
    // on rather than guessing.
    return {
      dirConfigured: false,
      persistent: false,
      boots,
      detail:
        'JARVIS_DATA_DIR is not set, so state lives beside the code. Fine locally; on a container host ' +
        'that is wiped on every deploy. Mount a volume and point JARVIS_DATA_DIR at it.',
    };
  }

  if (boots > 1) {
    return {
      dirConfigured: true,
      persistent: true,
      boots,
      firstSeenAt: data.firstSeenAt,
      detail: `Data has survived ${boots - 1} restart${boots === 2 ? '' : 's'} since ${formatDate(data.firstSeenAt)}.`,
    };
  }

  // One boot is genuinely ambiguous — a first-ever start looks exactly like a
  // directory that was just emptied. Rather than guess, this names the one
  // observation that settles it.
  return {
    dirConfigured: true,
    persistent: null,
    boots,
    firstSeenAt: data.firstSeenAt,
    detail:
      'First boot seen in this directory. Redeploy and check again: if this still says first boot, ' +
      'the volume is not persisting and everything the company remembers is being erased each time.',
  };
}

/** Shouted at startup, because a silent data loss is the whole problem. */
export function warnIfEphemeral() {
  const status = getStorageStatus();
  if (status.persistent === false) {
    console.warn(`⚠ Storage is not persistent: ${status.detail}`);
  }
  return status;
}

function formatDate(value) {
  if (!value) return 'an unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'an unknown date' : date.toISOString().slice(0, 10);
}
