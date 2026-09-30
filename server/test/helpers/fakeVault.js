// A tiny in-memory GitHub repo behind global.fetch, with the two behaviours
// the vault code depends on: blob shas that change with content, and a PUT that
// is refused (422) when it creates over an existing file or names a stale sha.
import crypto from 'node:crypto';

const sha = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');

export function fakeVault(initial = {}) {
  const files = { ...initial };
  const puts = [];
  const gets = [];
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/git/trees/')) {
      return json(200, { tree: Object.entries(files).map(([p, c]) => ({ type: 'blob', path: p, size: c.length, sha: sha(c) })) });
    }
    const m = u.match(/\/contents\/(.+?)(\?ref=.*)?$/);
    const p = m ? decodeURI(m[1]) : '';
    if (opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      if (p in files) {
        if (!body.sha || body.sha !== sha(files[p])) return json(422, { message: 'sha does not match' });
      } else if (body.sha) {
        return json(422, { message: 'sha given for a file that does not exist' });
      }
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      puts.push({ path: p, content, message: body.message });
      files[p] = content;
      return json(200, { commit: { sha: 'abc', html_url: 'u' } });
    }
    gets.push(p);
    if (p in files) return json(200, { content: Buffer.from(files[p]).toString('base64'), sha: sha(files[p]) });
    return json(404, { message: 'Not Found' });
  };
  return { files, puts, gets };
}

export const KEYS = ['WORKSPACE_REPO_OWNER', 'WORKSPACE_REPO_NAME', 'WORKSPACE_REPO_BRANCH', 'GITHUB_TOKEN', 'VAULT_LESSONS_PER_DAY', 'VAULT_LESSON_TTL_DAYS', 'VAULT_READ_CHARS_PER_RUN'];

export function configureVault() {
  process.env.WORKSPACE_REPO_OWNER = 'alex';
  process.env.WORKSPACE_REPO_NAME = 'brain';
  process.env.GITHUB_TOKEN = 't';
}
