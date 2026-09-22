// A support desk for people who use somebody else's software.
//
// The founder asked for a call centre that solves problems with the Amadeus
// application, in any language, on a live call. The conversation half of that
// already exists. What a call centre needs on top is the thing no model has:
// the procedures. A desk that answers from training data will confidently
// walk a travel agent through steps that were true in 2023, and a wrong step
// on a support call is worse than no step — it costs the caller an hour and
// the desk its credibility.
//
// So the desk knows exactly what is in its knowledge base and nothing else.
// It looks procedures up mid-call with `lookup_issue`; when nothing matches it
// says so and opens a ticket with `open_ticket`, which reaches the founder by
// email. "I don't have that one — let me log it and someone will come back to
// you" is a real answer. An invented one is not.
//
// Two boundaries, both structural rather than requested:
//
//   1. It is not the vendor. Amadeus is a real company. This desk is an
//      independent one for their users, and says so if asked. The brief is
//      written so it cannot introduce itself as the vendor.
//   2. It holds no company state. Same allowlist discipline as deskBrief.js:
//      what the prompt never contained cannot be leaked from it.
//
// The knowledge base lives in the data directory and is edited from WhatsApp
// (ISSUE / ISSUES / ISSUE DEL in founderCommands.js), because the founder is
// on a phone and a file nobody can edit is a knowledge base nobody can grow.

import { readJson, writeJson } from '../store.js';
import { fingerprint, similarity } from '../pitchOfTheDay.js';
import { languageName, pinnedLanguage } from '../language.js';
import { sendTicketEmail } from '../email.js';

const FILE = 'support.json';
const TICKETS = 'tickets.json';

// Below this the match is noise. Loose on purpose: the cost of a weak match
// is one irrelevant procedure read to the model, which it can discard; the
// cost of a missed match is a ticket for something already on record.
const MATCH_FLOOR = 0.12;
const MAX_MATCHES = 3;

export function supportProduct() {
  return (process.env.SUPPORT_PRODUCT || '').trim() || 'Amadeus';
}

export function supportDeskName() {
  const configured = (process.env.SUPPORT_DESK_NAME || '').trim();
  return configured || `the ${supportProduct()} support desk`;
}

/** Opens in this language; follows the caller from their first word. */
export function supportLanguage() {
  return languageName((process.env.DESK_LANGUAGE || '').trim()) || pinnedLanguage() || 'English';
}

// --- The knowledge base -----------------------------------------------------------------

// Starting procedures, so the desk is not mute on day one. Every one is
// triage — gather the exact error, check the environment, restart the
// client, capture what is on screen — and none asserts an internal of the
// product that this code cannot verify. They are labelled as examples in
// ISSUES so the founder replaces them with real procedures rather than
// mistaking them for ones.
const SEED_ISSUES = [
  {
    title: 'Cannot sign in',
    symptoms: 'login fails, password rejected, account locked, sign-in page loops, office id not accepted',
    steps:
      'Confirm they are on the right sign-in environment (production vs training) and the right office ID. ' +
      'Ask for the exact message on screen, word for word. If it says locked, tell them not to retry — ' +
      'retries extend the lock — and open a ticket with their username and office ID (never the password). ' +
      'If it is a wrong-password message, have them reset it through the official reset link, not by telling you the password.',
    example: true,
  },
  {
    title: 'PNR will not save or end transaction fails',
    symptoms: 'cannot end transaction, ER rejected, PNR error, booking will not commit, mandatory element missing',
    steps:
      'Ask for the exact error text and the last entry they typed. Most save failures name a missing mandatory element — ' +
      'a contact, a ticketing arrangement, a received-from. Have them check each one is present before retrying. ' +
      'If the error names a segment, have them display the itinerary and read the segment statuses back. ' +
      'If it is still rejected after the mandatory elements are confirmed, open a ticket with the error text and the record locator.',
    example: true,
  },
  {
    title: 'Ticketing or e-ticket error',
    symptoms: 'ticket issue fails, e-ticket rejected, fare not stored, TST error, printing fails, ticket number missing',
    steps:
      'Confirm a fare is stored on the record and that it has not expired — re-price if it has. ' +
      'Ask for the exact rejection text. If it mentions the ticketing authority, form of payment or validating carrier, ' +
      'have them check that element specifically. If a ticket number was generated but the printout failed, do not re-issue — ' +
      'open a ticket so the number is not duplicated.',
    example: true,
  },
  {
    title: 'Queue handling',
    symptoms: 'queue count wrong, cannot access queue, records missing from queue, queue placement fails',
    steps:
      'Confirm the office ID and queue number they are working. Have them display the queue count for that queue. ' +
      'If the count is right but records are missing, ask whether another agent is working the same queue — records are ' +
      'removed as they are actioned. If the queue cannot be accessed at all, note the exact message and open a ticket.',
    example: true,
  },
  {
    title: 'Application slow, frozen or disconnecting',
    symptoms: 'slow, frozen, hangs, times out, disconnected, session expired, connection lost, screen not responding',
    steps:
      'Ask whether it is one screen or the whole application, and whether colleagues on the same network see it. ' +
      'If it is only them: restart the application, then the machine. If it is the whole office: it is likely the network ' +
      'or proxy, and their IT is the right call. If it started after an update, note the version. Open a ticket with the time it started ' +
      'and how many people are affected.',
    example: true,
  },
];

function load() {
  const data = readJson(FILE, { issues: null });
  // First run: seed. Later runs: whatever the founder has made of it, even if
  // that is an empty list — deleting every example is a valid state and must
  // not resurrect them.
  if (data.issues === null) {
    const seeded = { issues: SEED_ISSUES.map((issue, i) => ({ ...issue, id: i + 1, at: new Date().toISOString() })) };
    writeJson(FILE, seeded);
    return seeded;
  }
  return data;
}

export function listIssues() {
  return load().issues;
}

export function addIssue({ title, symptoms, steps }) {
  const t = String(title || '').trim();
  const sy = String(symptoms || '').trim();
  const st = String(steps || '').trim();
  if (!t || !sy || !st) throw new Error('An issue needs a title, the symptoms a caller would describe, and the steps.');
  const data = load();
  const id = data.issues.reduce((max, issue) => Math.max(max, issue.id), 0) + 1;
  const issue = { id, title: t, symptoms: sy, steps: st, example: false, at: new Date().toISOString() };
  data.issues.push(issue);
  writeJson(FILE, data);
  return issue;
}

export function removeIssue(id) {
  const data = load();
  const before = data.issues.length;
  data.issues = data.issues.filter((issue) => issue.id !== Number(id));
  if (data.issues.length === before) throw new Error(`There is no issue #${id}.`);
  writeJson(FILE, data);
  return true;
}

/**
 * The procedures closest to what the caller described.
 *
 * Token overlap, reusing the pitch de-duplicator: it is the wrong tool for
 * semantic search and the right tool for a knowledge base of forty entries
 * edited from a phone. Symptoms are weighted by being matched on their own as
 * well as with the title, because a caller describes symptoms and never the
 * title.
 */
export function findIssues(problem) {
  const query = fingerprint(problem);
  if (!query.size) return [];
  return listIssues()
    .map((issue) => {
      const bySymptoms = similarity(problem, issue.symptoms);
      const byAll = similarity(problem, `${issue.title} ${issue.symptoms}`);
      return { issue, score: Math.max(bySymptoms, byAll) };
    })
    .filter(({ score }) => score >= MATCH_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES);
}

// --- Tickets ---------------------------------------------------------------------------------

export function listTickets() {
  return readJson(TICKETS, { tickets: [] }).tickets;
}

export async function openTicket({ summary, callerName = '', contact = '', language = '', from = '' }) {
  const text = String(summary || '').trim();
  if (!text) throw new Error('A ticket needs a summary of the problem.');
  const data = readJson(TICKETS, { tickets: [] });
  const ticket = {
    id: data.tickets.length + 1,
    at: new Date().toISOString(),
    product: supportProduct(),
    summary: text,
    callerName: String(callerName || '').trim(),
    contact: String(contact || '').trim(),
    language: String(language || '').trim(),
    from: String(from || '').trim(),
    status: 'open',
  };
  data.tickets.push(ticket);
  writeJson(TICKETS, data);
  // The email is the point — a ticket nobody is told about is a note to
  // self. Failure to send is logged and does not lose the ticket.
  try {
    await sendTicketEmail(ticket);
  } catch (err) {
    console.error(`Ticket #${ticket.id} saved but the email failed:`, err.message);
  }
  return ticket;
}

// --- Tools the desk can use on a call ----------------------------------------------------

export const LOOKUP_ISSUE = {
  type: 'function',
  name: 'lookup_issue',
  description:
    'Find the procedure for the problem the caller has described. Call it as soon as you understand what is wrong, ' +
    'before giving any steps. It returns the matching procedures on record, or says there is none. Only give steps ' +
    'that came back from this tool.',
  parameters: {
    type: 'object',
    properties: {
      problem: {
        type: 'string',
        description: "The problem in the caller's own terms, including any exact error text they read out. In English.",
      },
    },
    required: ['problem'],
  },
};

export const OPEN_TICKET = {
  type: 'function',
  name: 'open_ticket',
  description:
    'Log a problem for a human to follow up. Use it when no procedure matched, when the procedure did not fix it, ' +
    'or when the caller asks for a person. Get their name and a way to reach them first. Returns the ticket number ' +
    'to read back to them.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What is wrong, what was tried, and any exact error text. In English.' },
      callerName: { type: 'string', description: "The caller's name, as they gave it." },
      contact: { type: 'string', description: 'How to reach them: an email address or a phone number they gave.' },
      language: { type: 'string', description: 'The language the call is in, so the follow-up is in it too.' },
    },
    required: ['summary'],
  },
};

export const SUPPORT_TOOLS = [LOOKUP_ISSUE, OPEN_TICKET];

/**
 * Runs one of the desk's tools. The same function behind the browser
 * endpoint and the phone bridge, so a caller gets the same procedures
 * whichever way they reached the desk.
 */
export async function runSupportTool(name, args = {}, { from = '' } = {}) {
  if (name === 'lookup_issue') {
    const matches = findIssues(args.problem || '');
    if (!matches.length) {
      return (
        'No procedure on record matches that. Do not improvise steps. Tell the caller you do not have a procedure ' +
        'for this one, and offer to open a ticket so someone comes back to them.'
      );
    }
    return [
      `${matches.length} procedure${matches.length === 1 ? '' : 's'} on record. Give the steps from the closest one; mention the others only if the first does not fit:`,
      ...matches.map(({ issue }, i) => `${i + 1}. ${issue.title}\n   Symptoms: ${issue.symptoms}\n   Steps: ${issue.steps}`),
    ].join('\n\n');
  }
  if (name === 'open_ticket') {
    const ticket = await openTicket({ ...args, from });
    return `Ticket #${ticket.id} is open. Read the number back to the caller and tell them someone will follow up${ticket.contact ? ` at ${ticket.contact}` : ''}.`;
  }
  return `There is no tool called "${name}" on this desk.`;
}

// --- The brief -----------------------------------------------------------------------------

export function supportGreeting() {
  return (
    `Open the call. Say hello, give the desk's name — "${supportDeskName()}" — and ask what the problem is, ` +
    `in ${supportLanguage()}. One sentence. Do not list what you can do, and do not say you are an AI unless they ask ` +
    'directly, in which case say so plainly.'
  );
}

export function buildSupportInstructions() {
  const product = supportProduct();
  return `You are answering the phone at ${supportDeskName()}, an independent support desk for people who use ${product}. You are not ${product}, you do not work for ${product}, and you never say or imply that you do. If a caller asks whether they have reached ${product}, say plainly that this is an independent desk for ${product} users.

LANGUAGE
Open in ${supportLanguage()}. From the moment they speak, use their language and keep using it — switch again if they do. Never comment on which language is in use and never ask them to repeat in another one. Keep product names, error codes and command entries exactly as they are, in every language.

HOW A SUPPORT CALL GOES
1. Find out what is wrong. Ask for the exact message on their screen, word for word, and what they did just before it appeared.
2. Call lookup_issue with the problem in their words. Do this before giving any steps.
3. Give the steps that came back, one at a time. Say one step, wait for them to do it, ask what happened, then the next. Never read a whole procedure in one breath.
4. If it is fixed, say so and ask if there is anything else.
5. If nothing matched, or the steps did not fix it, or they ask for a person: get their name and a way to reach them, call open_ticket, and read the ticket number back.

HOW TO TALK
- One or two sentences, then stop. They are on a call, often mid-problem, and cannot re-read you.
- Calm. They are frustrated and it is not with you.
- If you did not catch something — an error code, a name — ask them to repeat it. Never guess at an error code.

WHAT YOU MUST NOT DO
- Never give a step that did not come back from lookup_issue. You do not know ${product}'s internals, and a wrong step costs them an hour. "I don't have a procedure for that one" is a real answer; an invented one is not.
- Never ask for a password, a full card number or a security code. If they start reading one out, stop them.
- Never promise a fix, a time, or that ${product} will do anything. You can log a ticket; you cannot commit anyone.
- Never discuss this company's business, other callers, or anything not about their problem.

The call is transcribed and every ticket reaches a person. Say so if they ask whether anyone will actually follow up.`;
}

/** For the founder, checking what a caller would reach. */
export function describeSupportDesk() {
  const issues = listIssues();
  const examples = issues.filter((i) => i.example).length;
  return (
    `Callers reach ${supportDeskName()}, opening in ${supportLanguage()} and then following the caller. ` +
    `${issues.length} procedure${issues.length === 1 ? '' : 's'} on record` +
    (examples ? ` (${examples} still the starting examples — replace them with ISSUE)` : '') +
    `. Anything it cannot solve becomes a ticket emailed to you.`
  );
}
