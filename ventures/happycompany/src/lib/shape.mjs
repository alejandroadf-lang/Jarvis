// The shape of a product event, without its content.
//
// Three fields the normaliser relies on could not be checked without a real
// site: where a Confluence event carries the space, where the mention event
// names the mentioned account, and what the changelog items look like. The
// way to check is to look at real events, and the way to do that without
// breaking the app's own promise (no text, no names, no ids) is to log
// structure only: every key path and the type of its value, never a value.
//
// It is off unless the Forge environment variable HAPPYCOMPANY_LOG_SHAPES is
// "1", which is set per environment with `forge variables set`, so it can be
// on in development and cannot be on in a customer's production install
// unless the vendor deploys it that way. Keep it that way.

const MAX_KEYS = 200;
const MAX_DEPTH = 6;

/** Sorted "path: type" lines. Arrays show their first element as [0]. */
export function eventShape(value) {
  const lines = [];
  const walk = (v, path, depth) => {
    if (lines.length >= MAX_KEYS) return;
    if (v === null) return void lines.push(`${path}: null`);
    if (Array.isArray(v)) {
      lines.push(`${path}: array(${v.length})`);
      if (v.length && depth < MAX_DEPTH) walk(v[0], `${path}[0]`, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      if (depth >= MAX_DEPTH) return void lines.push(`${path}: object`);
      for (const key of Object.keys(v).sort()) walk(v[key], path ? `${path}.${key}` : key, depth + 1);
      return;
    }
    lines.push(`${path}: ${typeof v}`);
  };
  walk(value, '', 0);
  return lines;
}

export function shapeLoggingOn(env = process.env) {
  return env.HAPPYCOMPANY_LOG_SHAPES === '1';
}
