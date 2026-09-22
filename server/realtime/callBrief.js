// What the voice on the phone knows before it says hello.
//
// The company's considered answer takes about fifteen seconds, because a CEO
// delegating to a CTO delegating to a Solutions Architect is three model calls
// deep. A phone call cannot wait that long: past about a second of silence a
// human assumes the line has dropped. So the thing that picks up is not the
// org chart — it is one fast model holding the company's live state in its
// head, which is enough to answer most of what gets asked.
//
// The division is deliberate. Anything already known — revenue, pipeline,
// which ventures are live, what is waiting on the founder — is in this brief
// and answered instantly. Anything requiring judgment, research or an action
// goes to the team through `ask_the_team`, and the call keeps going while it
// does. Those are different questions and they deserve different latencies.

import { buildCompanyContext } from '../finance/context.js';
import { describeLanguageSetting, pinnedLanguage } from '../language.js';
import { maxCallSeconds } from './callPolicy.js';

/**
 * The standing instructions for a call.
 *
 * Written for speech rather than for reading. The model is told to be brief
 * not as a style preference but because there is no scrollback on a phone
 * call: a listener who misses a sentence cannot go back for it, and a
 * paragraph delivered at speaking pace is thirty seconds the caller cannot
 * skim.
 */
export function buildCallInstructions({ callerName = 'the founder', language: chosen = '' } = {}) {
  // A language chosen on the keypad (languageMenu.js) outranks the pinned
  // one for this call: the founder pressed the button, and the setting is
  // the default for when nobody does.
  const pinned = chosen || pinnedLanguage();
  const language = pinned
    ? `Speak ${pinned}, whatever language ${callerName} uses. Keep product names, ventureIds and commands unchanged.`
    : `Speak whatever language ${callerName} speaks, and switch when they switch. Keep product names, ventureIds and commands unchanged.`;

  return `You are answering the phone for this company. You are speaking with ${callerName}, who owns it.

HOW TO TALK
You are on a live call. There is no scrollback: anything they miss is gone.
- Answer in one or two sentences, then stop and let them talk. A paragraph out loud is thirty seconds they cannot skim.
- Lead with the answer. Never open with a preamble about what you are about to do.
- Numbers out loud: "twenty-nine dollars a month", not "USD 29.00/month". Say ventureIds letter by letter only if asked to.
- Never read a list of more than three things aloud. Say the count, name the most important, and offer the rest.
- If you did not catch something, say so and ask. Guessing on a call is worse than guessing in writing, because they cannot see what you assumed.
- ${language}

WHAT YOU KNOW
Everything under COMPANY STATE below is current as of the moment this call started. Answer from it directly and immediately — that is what it is for.

WHAT YOU DO NOT KNOW
You cannot see the internet and you have not asked anyone anything. You are one voice, not the company. When the question needs judgment, research, a decision, or any action in the world, use ask_the_team.

USING ask_the_team
Call it as soon as you know the question needs it — do not think out loud first. Say something short and natural while it runs ("let me put that to them"), then keep talking with ${callerName} about anything else. The answer arrives mid-call; when it does, say so and deliver it.
Never answer a question you sent to the team by guessing at what they will say. If you already said you were asking, wait for it.

WHAT YOU MUST NOT DO
- Do not invent a number, a name, a date or a commitment. If it is not below and the team has not said it, you do not know it.
- Do not agree to send anything, pay anything, or promise anything to anyone outside the company. Those go through the team and the founder's approval, never through a phone call.
- Do not say you cannot hear them or that you have no voice. You are on a call.

The call ends automatically after ${Math.round(maxCallSeconds() / 60)} minutes. If you are near that, say so rather than being cut off mid-sentence.

COMPANY STATE
${buildCompanyContext()}`;
}

/** The first thing the caller hears. Short, because they just dialled. */
export function callGreeting({ language = '' } = {}) {
  return (
    `Greet them in one short sentence${language ? `, in ${language},` : ''} and ask what they need. Do not list what you can do, ` +
    'do not summarise the company, and do not say you are an AI assistant — they know who they called.'
  );
}

/** For the founder, checking their setup. */
export function describeCallLanguage() {
  return describeLanguageSetting();
}
