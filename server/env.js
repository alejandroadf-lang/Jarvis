// Reading credentials out of the environment, carefully.
//
// Every provider check in this app used to be `Boolean(process.env.X)`, which
// is true for a whitespace-only value. That produced a failure worth naming,
// because it defeated the fallback designed to prevent it: a key set to " "
// read as configured, so the tier did not collapse to the default model, and
// the request went out as `Authorization: Bearer ` with nothing after it.
// OpenRouter answered "Missing Authentication header" — which reads as a
// broken integration rather than an unset variable, and sent the team looking
// for a tool that did not exist.
//
// Dashboards make this easy to do. A variable typed and cleared leaves an
// empty string; a value pasted with quotes or a trailing newline arrives with
// them attached.

/**
 * A credential, or '' when there isn't one worth sending.
 *
 * Surrounding quotes are stripped because pasting `"sk-..."` into a variables
 * panel is common and the quotes travel with it — and a key that is merely
 * wrong fails far more legibly than one that is subtly malformed.
 */
export function readSecret(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/^["']|["']$/g, '').trim();
  return trimmed;
}

/** Whether a credential is actually usable, rather than merely present. */
export function hasSecret(name) {
  return readSecret(name).length > 0;
}
