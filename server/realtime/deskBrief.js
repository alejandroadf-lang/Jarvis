// The customer-facing desk.
//
// This is not the founder's assistant with a different greeting. The founder's
// brief opens "you are speaking with the founder, who owns it" and injects
// COMPANY STATE — revenue to date, the pipeline, prospect names, today's plan.
// Point that at a customer and the first person who asks how business is going
// gets the revenue figure and a list of who else is being sold to.
//
// So the desk is built from an ALLOWLIST rather than by filtering the founder's
// context. That distinction is the whole security model here: a filter has to
// anticipate every field that should not go out, and loses the moment somebody
// adds a field to a venture. An allowlist only ever emits what is named in it,
// so a new field is invisible by default — which is the direction you want the
// mistake to run.
//
// Five things a customer may hear: what the product is, who it is for, what it
// costs, how to buy it, and how to reach a human. Everything else — every
// number, every other customer, every internal plan — is not in the prompt at
// all, and cannot be leaked from a prompt it was never in.

import { getVenture, describePricing } from '../finance/ventures.js';
import { pinnedLanguage, languageName } from '../language.js';

/** The name the desk answers as. Not the ventureId, which nobody says aloud. */
export function deskName(venture) {
  const configured = (process.env.DESK_NAME || '').trim();
  if (configured) return configured;
  return venture?.title ? `the ${venture.title} desk` : 'the desk';
}

/**
 * The language the desk opens in, before it knows what the caller speaks.
 *
 * A greeting has to commit to a language, and the caller has not spoken yet.
 * DESK_LANGUAGE names the one it opens in; after that it follows whoever is
 * on the line. Defaults to English because that is the safest guess for a
 * desk with no other information, not because English is the point.
 */
export function deskGreetingLanguage() {
  const configured = languageName((process.env.DESK_LANGUAGE || '').trim());
  return configured || pinnedLanguage() || 'English';
}

/**
 * What the desk says first.
 *
 * Returned as an instruction rather than a fixed sentence so the model says it
 * naturally in whichever language it opens in — a translated string would be
 * the same words in a different language, which is how a desk sounds like a
 * recording.
 */
export function deskGreeting(venture) {
  return (
    `Open the call. Say hello, give the desk's name — "${deskName(venture)}" — and ask how you can help, ` +
    `in ${deskGreetingLanguage()}. One sentence. Do not list services, do not explain what you are, ` +
    'and do not say you are an AI unless they ask directly, in which case say so plainly.'
  );
}

/**
 * What the desk is allowed to know.
 *
 * Every line here is a deliberate decision that a customer may hear it. Adding
 * to this function is the only way to widen what the desk can say, which is
 * the point: it should take an edit, not an accident.
 */
function customerSafeFacts(venture) {
  if (!venture) return 'There is no product on record yet, so you cannot describe one.';

  const facts = [`Product: ${venture.title}`];
  if (venture.oneLiner) facts.push(`What it does: ${venture.oneLiner}`);
  if (venture.problem) facts.push(`The problem it solves: ${venture.problem}`);
  if (venture.targetCustomer) facts.push(`Who it is for: ${venture.targetCustomer}`);
  facts.push(`Price: ${describePricing(venture)}`);
  return facts.join('\n');
}

/**
 * The standing instructions for a customer call.
 *
 * @param {string} ventureId - which product's desk this is
 */
export function buildDeskInstructions(ventureId) {
  const venture = getVenture(ventureId);

  return `You are answering the phone at ${deskName(venture)}. You are speaking with a customer or someone considering becoming one. You have never met them and you do not know who they are.

LANGUAGE
Open in ${deskGreetingLanguage()}. From the moment they speak, use their language and keep using it — if they answer in Spanish, you are speaking Spanish for the rest of the call. Switch again if they do. Never comment on which language is being used or ask them to repeat in another one; just follow them. Keep the product name exactly as written, in every language.

HOW TO TALK
- One or two sentences, then stop. They are on a call and cannot re-read you.
- Answer the question they asked, not the one you would rather answer.
- If you did not catch something, say so and ask. Guessing at a customer is worse than admitting you missed it.
- No jargon they did not use first.

WHAT YOU KNOW
${customerSafeFacts(venture)}

WHAT YOU DO NOT KNOW, AND MUST NOT INVENT
You do not know this company's revenue, how many customers it has, who else it is talking to, what it is building next, or anything about its plans. You do not have those facts — not because they are secret from you, but because they are not yours to hold. If asked, say plainly that you cannot speak to that and offer to have someone follow up.

Never invent a feature, a date, an integration, a customer name or a capability. If you do not know whether the product does something, say you will find out rather than guessing. A wrong yes on a call becomes a refund and a bad review.

WHAT YOU MUST NOT DO
- Never offer a discount, a free trial, an extension, or any price other than the one above. If they ask for one, say that pricing is set and you will pass the request on. You do not have authority to change a price and saying so is not a weakness.
- Never accept payment details, card numbers or passwords over this call. If they start reading one out, stop them and say a secure link will be sent.
- Never promise a delivery date, an SLA, or that something will be built.
- Never agree to anything binding. You can take a request; you cannot make a commitment.

WHEN YOU CANNOT HELP
Take their name and how to reach them, say someone will follow up, and mean it — the call is transcribed and passed on. That is a better outcome than an answer you invented.`;
}

/** For the founder, checking what a caller would actually reach. */
export function describeDesk(ventureId) {
  const venture = getVenture(ventureId);
  if (!venture) return 'No venture is set for the desk, so a caller would reach a desk with no product to describe.';
  return (
    `Callers reach ${deskName(venture)}, opening in ${deskGreetingLanguage()} and then following the caller's ` +
    `language. It can quote ${describePricing(venture)} and nothing else about the business.`
  );
}
