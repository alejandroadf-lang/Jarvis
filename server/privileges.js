// Running without root.
//
// The container starts as root and, until this, stayed root: every agent
// turn, every WhatsApp message, the Circadian child process, all with the
// power to rewrite the image itself. Nothing here needs that. The audit put it
// last because the obvious fix is the dangerous one: a `USER node` line in the
// Dockerfile makes the app start as uid 1000 against a Railway volume that is
// mounted owned by root, the first write fails, and the company is down with
// its data unreadable to it.
//
// So the drop happens here instead, after the one thing that needs root:
// handing the data directories to the unprivileged user. Order matters and is
// fixed: groups, then gid, then uid. Once the uid is gone the process can no
// longer change its gid, so doing it the other way round leaves it in root's
// group.
//
// Never fatal. If anything fails, the app stays root and says so; a server
// that refuses to start over a hardening step has turned the hardening into
// the outage. RUN_AS_ROOT=true skips the drop entirely, as the way out from a
// phone if a platform ever mounts something the unprivileged user cannot use.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_USER = 'node'; // present in every official node image, uid 1000

/** The uid and gid of a user, from /etc/passwd. Null when there is no such user. */
export function lookupUser(name, passwdText) {
  for (const line of String(passwdText || '').split('\n')) {
    const [user, , uid, gid] = line.split(':');
    if (user === name && /^\d+$/.test(uid) && /^\d+$/.test(gid)) return { uid: Number(uid), gid: Number(gid) };
  }
  return null;
}

function chownTree(fsImpl, dir, uid, gid) {
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.chownSync(dir, uid, gid);
  for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) chownTree(fsImpl, full, uid, gid);
    else fsImpl.chownSync(full, uid, gid);
  }
}

/**
 * Hands `dirs` to the unprivileged user and drops to it, when running as root.
 *
 * @returns {{ dropped: boolean, reason: string }} what happened, for the log
 */
export function dropRoot({
  dirs,
  env = process.env,
  proc = process,
  fsImpl = fs,
  passwd = () => fsImpl.readFileSync('/etc/passwd', 'utf-8'),
  userName = DEFAULT_USER,
} = {}) {
  if (typeof proc.getuid !== 'function' || proc.getuid() !== 0) {
    return { dropped: false, reason: 'not running as root; nothing to drop' };
  }
  if ((env.RUN_AS_ROOT || '').trim().toLowerCase() === 'true') {
    return { dropped: false, reason: 'RUN_AS_ROOT=true, so the server stays root' };
  }
  let user;
  try {
    user = lookupUser(userName, passwd());
  } catch (err) {
    return { dropped: false, reason: `could not read /etc/passwd (${err.message}); staying root` };
  }
  if (!user) return { dropped: false, reason: `no "${userName}" user in this image; staying root` };

  try {
    for (const dir of dirs) chownTree(fsImpl, dir, user.uid, user.gid);
  } catch (err) {
    return { dropped: false, reason: `could not hand ${err.path || 'a data directory'} to ${userName} (${err.code || err.message}); staying root` };
  }

  try {
    if (typeof proc.setgroups === 'function') proc.setgroups([user.gid]);
    proc.setgid(user.gid);
    proc.setuid(user.uid);
  } catch (err) {
    return { dropped: false, reason: `could not switch to ${userName} (${err.message}); staying root` };
  }
  return { dropped: true, reason: `running as ${userName} (uid ${user.uid}); data directories handed over: ${dirs.join(', ')}` };
}
