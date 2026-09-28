// The privilege drop runs once, at boot, on the live server, and can only be
// seen working in a container. So what is pinned here is the part that can
// go wrong quietly: the order of the switch (gid before uid, or the process
// keeps root's group), that the data directories are handed over first (or
// the first write after the drop fails), and that every failure leaves the
// server running as root rather than not running.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dropRoot, lookupUser } from '../privileges.js';

const PASSWD = 'root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n';

function fakeProc(uid = 0) {
  const calls = [];
  return {
    calls,
    getuid: () => uid,
    setgroups: (g) => calls.push(['setgroups', g]),
    setgid: (g) => calls.push(['setgid', g]),
    setuid: (u) => calls.push(['setuid', u]),
  };
}

// A directory tree in memory: /data with a file and a sub-directory.
function fakeFs({ failOn = null } = {}) {
  const tree = { '/data': ['ventures.json', 'circadian'], '/data/circadian': ['whoop.json'] };
  const owned = [];
  return {
    owned,
    mkdirSync: () => {},
    readdirSync: (dir) => (tree[dir] || []).map((name) => ({ name, isDirectory: () => Boolean(tree[path.join(dir, name)]) })),
    chownSync: (p, uid, gid) => {
      if (p === failOn) throw Object.assign(new Error('EPERM'), { code: 'EPERM', path: p });
      owned.push([p, uid, gid]);
    },
  };
}

test('as root, the data directories are handed over, then groups, gid, uid, in that order', () => {
  const proc = fakeProc(0);
  const fsImpl = fakeFs();
  const out = dropRoot({ dirs: ['/data'], env: {}, proc, fsImpl, passwd: () => PASSWD });
  assert.equal(out.dropped, true);
  assert.deepEqual(fsImpl.owned.map(([p]) => p).sort(), ['/data', '/data/circadian', '/data/circadian/whoop.json', '/data/ventures.json']);
  assert.ok(fsImpl.owned.every(([, uid, gid]) => uid === 1000 && gid === 1000));
  assert.deepEqual(proc.calls, [['setgroups', [1000]], ['setgid', 1000], ['setuid', 1000]]);
});

test('not root: nothing is touched', () => {
  const proc = fakeProc(1000);
  const fsImpl = fakeFs();
  const out = dropRoot({ dirs: ['/data'], env: {}, proc, fsImpl, passwd: () => PASSWD });
  assert.equal(out.dropped, false);
  assert.deepEqual(fsImpl.owned, []);
  assert.deepEqual(proc.calls, []);
});

test('RUN_AS_ROOT=true keeps root and touches nothing', () => {
  const proc = fakeProc(0);
  const fsImpl = fakeFs();
  const out = dropRoot({ dirs: ['/data'], env: { RUN_AS_ROOT: ' TRUE ' }, proc, fsImpl, passwd: () => PASSWD });
  assert.equal(out.dropped, false);
  assert.match(out.reason, /RUN_AS_ROOT/);
  assert.deepEqual(proc.calls, []);
});

test('a directory that cannot be handed over leaves the server running as root, and says which', () => {
  const proc = fakeProc(0);
  const out = dropRoot({ dirs: ['/data'], env: {}, proc, fsImpl: fakeFs({ failOn: '/data/circadian' }), passwd: () => PASSWD });
  assert.equal(out.dropped, false);
  assert.match(out.reason, /could not hand \/data\/circadian to node \(EPERM\); staying root/);
  assert.deepEqual(proc.calls, [], 'no half-dropped process');
});

test('an image without the user stays root', () => {
  const proc = fakeProc(0);
  const out = dropRoot({ dirs: ['/data'], env: {}, proc, fsImpl: fakeFs(), passwd: () => 'root:x:0:0::/root:/bin/sh\n' });
  assert.equal(out.dropped, false);
  assert.match(out.reason, /no "node" user/);
  assert.deepEqual(proc.calls, []);
});

test('a failed switch is reported, not thrown', () => {
  const proc = { ...fakeProc(0), setuid: () => { throw new Error('EPERM'); } };
  const out = dropRoot({ dirs: ['/data'], env: {}, proc, fsImpl: fakeFs(), passwd: () => PASSWD });
  assert.equal(out.dropped, false);
  assert.match(out.reason, /could not switch to node \(EPERM\); staying root/);
});

test('lookupUser reads uid and gid, and ignores malformed lines', () => {
  assert.deepEqual(lookupUser('node', PASSWD), { uid: 1000, gid: 1000 });
  assert.equal(lookupUser('node', 'node:x:abc:1000::/:/bin/sh'), null);
  assert.equal(lookupUser('ghost', PASSWD), null);
});
