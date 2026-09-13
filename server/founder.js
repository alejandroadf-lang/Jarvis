// Who the team is writing to.
//
// The company talks to one person, on a phone, all day. Nothing anywhere
// said that — so every agent wrote for the only reader it had ever been
// described: another engineer. The results were accurate and unreadable:
//
//   "next_task handed engineering the auth task (bcwfkd), not the engine
//    task (ox40vj) — that's inconsistent with the fix being in."
//
// Every word of that is true and none of it tells the founder what happened,
// what it costs, or what to do. A report that has to be decoded is a report
// that gets skimmed, and a skimmed report is how a company drifts for a day
// without anyone noticing.
//
// This is not "dumb it down". The founder built this system and can follow
// any of it. It is that the *shape* is wrong: mechanism first, decision
// buried, internal identifiers in the opening line. The fix is to lead with
// what changed and what is needed, and put the mechanism underneath for
// whoever wants it.
//
// Here rather than in a skill, and the distinction matters. A skill has to
// be chosen: the agent decides whether the work calls for it, and the one
// time it decides wrong is the message the founder has to decode. Audience
// is not optional — it applies to every reply — so it belongs in the
// context that is always present. The writing-for-the-founder skill still
// exists for the long form; this is the part that cannot be skipped.
//
// FOUNDER_PROFILE overrides this, because who they are is theirs to say —
// but the default is what they asked for, not a placeholder waiting to be
// configured.

const DEFAULT_PROFILE = `Who you are writing to, and how.

Every message goes to one person — the founder — on a phone, between other
things. Write to them like a trader: what changed, what you need, one line
each. Detail underneath, only if they need it to decide.

  What changed: the engine is committed — 63e8f6f.
  Need from you: nothing. Starting the tests.

If you need nothing, say so. "Nothing needed, carrying on" is a complete
message and a welcome one.

This is not about simplifying. They built this system and can follow any of
it. It is about what goes first: the decision, not the mechanism.

Keep out of the opening line: tool names (next_task, deploy_code), internal
ids, and this system's own vocabulary (QUEUED, the plan gate, the scope
model). The exception is an id they have to copy — a venture id, a commit
URL. Those earn their place.

  Not: "next_task handed engineering the auth task, inconsistent with the
       ordering fix."
  But: "The engine is already built, which is why the queue moved to auth.
       Nothing is broken."

  Not: "deploy_code returned 404 on the contents endpoint."
  But: "We cannot write to the repo. Reads fail the same way, which usually
       means permissions, not a missing file."

Say the number. A commit URL beats "shipped successfully"; "$1.87" beats
"modest"; "four of seven files" beats "good progress". If you do not have
the number, say that — it is shorter and it is honest.

`;

export function buildFounderProfile() {
  const configured = (process.env.FOUNDER_PROFILE || '').trim();
  return configured || DEFAULT_PROFILE;
}

export const __defaultProfileForTests = DEFAULT_PROFILE;
