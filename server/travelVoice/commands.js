// Running the travel-advisor demo from a phone, with no browser open.
//
// Everything the Travel Voice tab does — see who is live, switch the voice,
// read the recent conversations, invite someone to try it — existed only in
// a browser. That is the wrong place for it. The demo is a WhatsApp number,
// it gets shown in an agency's office or over coffee, and the moment someone
// says "the voice sounds robotic" is the moment you want to change the voice,
// not the moment you want to find a laptop.
//
// These follow the same rules as the founder commands in
// channels/founderCommands.js, for the same reasons: a command has to be the
// whole message, matching is a deterministic string match rather than
// anything a model interprets, and they are only ever read from the founder's
// own allowlisted number. A guest talking to the advisor never reaches this
// file — see guests.js for why that asymmetry is enforced by routing.

import { listGuests, addGuest, removeGuest, clearGuests } from './guests.js';
import { allOverrides, setOverride, clearOverrides } from './providerPrefs.js';
import { findProvider, listProviders, describeProviders } from './providers/index.js';
import { normalizeLanguage, LANGUAGE_NAMES, DEFAULT_LANGUAGE } from './languages.js';
import { getSpendSummary } from '../spend.js';
import { formatUsd } from '../usage.js';

const SLOT_WORDS = { ears: 'stt', hearing: 'stt', brain: 'llm', model: 'llm', voice: 'tts', speech: 'tts' };

const COMMANDS = [
  { kind: 'help', re: /^travel(?:\s+(?:help|commands|\?))?$/i },
  { kind: 'status', re: /^travel\s+(?:status|health)$/i },
  { kind: 'mode_on', re: /^travel\s+on$/i },
  { kind: 'mode_off', re: /^travel\s+off$/i },
  { kind: 'log', re: /^travel\s+(?:log|recent|calls)$/i },
  // Slot first so "travel voice elevenlabs" is a pin, not an invite.
  { kind: 'pin', re: /^travel\s+(ears|hearing|brain|model|voice|speech)\s+(\S+)$/i },
  { kind: 'unpin', re: /^travel\s+(?:defaults|unpin|reset\s+providers)$/i },
  { kind: 'guests', re: /^travel\s+guests$/i },
  { kind: 'guest_remove', re: /^travel\s+(?:guest\s+)?remove\s+(\+?[\d\s()-]{6,})$/i },
  { kind: 'guest_clear', re: /^travel\s+guests\s+clear$/i },
  { kind: 'invite', re: /^travel\s+invite\s+(\+?[\d\s()-]{6,}?)(?:\s+(es|fr|en|spanish|french|english|español|francais|français))?$/i },
];

/**
 * A travel command, or null when the message is something else.
 *
 * Matched before the advisor-mode check in index.js, so TRAVEL OFF still
 * works while every other message on the line is going to the advisor.
 */
export function parseTravelCommand(text) {
  const trimmed = String(text || '').trim();
  for (const { kind, re } of COMMANDS) {
    const match = trimmed.match(re);
    if (!match) continue;
    if (kind === 'pin') return { kind, slot: SLOT_WORDS[match[1].toLowerCase()], provider: match[2].toLowerCase() };
    if (kind === 'invite') return { kind, number: match[1].trim(), language: normalizeLanguage(match[2]) };
    if (kind === 'guest_remove') return { kind, number: match[1].trim() };
    return { kind };
  }
  return null;
}

const HELP = `Travel advisor — what you can send from this number:

TRAVEL STATUS — what is live, and today's spend
TRAVEL ON / OFF — talk to the advisor from this line, or stop
TRAVEL INVITE <number> [es|fr|en] — let someone try it, and send them a spoken hello
TRAVEL GUESTS — who is invited
TRAVEL REMOVE <number> — take someone off the list
TRAVEL EARS|BRAIN|VOICE <provider> — switch one mid-demo
TRAVEL DEFAULTS — undo those switches
TRAVEL LOG — the last few conversations`;

function slotLine(kind, described) {
  const spec = described[kind];
  const active = spec.active || 'nothing configured';
  const where = { pinned: ' (pinned)', env: '', first: '', none: '' }[spec.source] || '';
  const options = spec.options.filter((o) => o.configured && o.id !== spec.active).map((o) => o.id);
  return `${active}${where}${options.length ? ` — also ready: ${options.join(', ')}` : ''}`;
}

/**
 * Runs one command and returns what to send back.
 *
 * @param {object} command from parseTravelCommand
 * @param {object} deps injected so this file reaches nothing by itself —
 *   the travelVoice orchestrator passes in what it owns.
 */
export async function runTravelCommand(command, deps = {}) {
  const {
    setAdvisorMode,
    recentTurns = () => [],
    inviteGuest,
    localized: t,
  } = deps;

  switch (command.kind) {
    case 'help':
      return HELP;

    case 'status': {
      const described = describeProviders();
      const spend = getSpendSummary();
      const guests = listGuests().length;
      return [
        'Travel advisor',
        `ears:  ${slotLine('stt', described)}`,
        `brain: ${slotLine('llm', described)}`,
        `voice: ${slotLine('tts', described)}`,
        `spend today: ${formatUsd(spend.spentUsd)} of ${formatUsd(spend.capUsd)}${spend.overCap ? ' — CAP REACHED, nothing will answer' : ''}`,
        `guests invited: ${guests}`,
      ].join('\n');
    }

    case 'mode_on':
      setAdvisorMode(true);
      return t('demoModeOn', DEFAULT_LANGUAGE);

    case 'mode_off':
      setAdvisorMode(false);
      return t('demoModeOff', DEFAULT_LANGUAGE);

    case 'pin': {
      const provider = findProvider(command.slot, command.provider);
      const options = listProviders(command.slot).map((p) => p.id).join(', ');
      if (!provider) return `No such provider "${command.provider}". Options: ${options}.`;
      if (!provider.configured()) return `${provider.label} has no key set, so pinning it would break the next answer. Options with a key: ${listProviders(command.slot).filter((p) => p.configured()).map((p) => p.id).join(', ') || 'none'}.`;
      setOverride(command.slot, provider.id);
      const what = { stt: 'Ears', llm: 'Brain', tts: 'Voice' }[command.slot];
      return `${what}: ${provider.label}${typeof provider.model === 'function' ? ` (${provider.model()})` : ''}. Takes effect on the next message. TRAVEL DEFAULTS puts it back.`;
    }

    case 'unpin': {
      const had = Object.keys(allOverrides()).length;
      clearOverrides();
      const described = describeProviders();
      return had
        ? `Back to the configured defaults — ears ${described.stt.active}, brain ${described.llm.active}, voice ${described.tts.active}.`
        : 'Nothing was pinned; already on the configured defaults.';
    }

    case 'log': {
      const turns = recentTurns(8);
      if (!turns.length) return 'Nothing yet. Nobody has messaged the advisor.';
      const lines = turns.map((turn) => {
        const when = new Date(turn.at).toISOString().slice(11, 16);
        const how = turn.voice ? 'voice' : 'text';
        const via = turn.providers ? ` [${[turn.providers.stt, turn.providers.llm, turn.providers.tts].filter(Boolean).join('/')}]` : '';
        // A wrong-language answer is the one thing worth seeing at a glance,
        // because it is the one that loses an agency.
        const wrong = turn.drift ? ` ⚠ wrong language${turn.drift.corrected ? ', fixed' : ''}` : '';
        const said = turn.transcript ? ` "${turn.transcript.slice(0, 50)}"` : '';
        return `${when} ${turn.from || '?'} ${turn.language || '?'} ${turn.stage} (${how})${via}${wrong}${said}`;
      });
      return [`Last ${turns.length} conversations:`].concat(lines).join('\n');
    }

    case 'guests': {
      const guests = listGuests();
      if (!guests.length) return 'Nobody is invited yet. TRAVEL INVITE <number> adds someone.';
      return [`${guests.length} invited to talk to the advisor:`]
        .concat(guests.map((g) => `  ${g.number}${g.language ? ` (${LANGUAGE_NAMES[g.language].native})` : ''}`))
        .join('\n');
    }

    case 'guest_remove':
      return removeGuest(command.number)
        ? `Removed. That number reaches nothing on this line now.`
        : `That number was not on the guest list.`;

    case 'guest_clear':
      clearGuests();
      return 'Guest list cleared. Nobody outside your own number reaches the advisor here.';

    case 'invite': {
      if (!inviteGuest) return 'Inviting is unavailable — WhatsApp is not configured for sending.';
      const result = await inviteGuest(command.number, { language: command.language });
      const lang = LANGUAGE_NAMES[result.language].native;
      // Said this way round on purpose: the invitation is live either way,
      // and the founder needs to know that before they try again.
      if (!result.delivered) {
        return (
          `${result.number} is on the guest list and can message this number now, ` +
          `but the hello did not go out — ${result.error}.`
        );
      }
      return (
        `Invited ${result.number}. They got a hello in ${lang}${result.spoke ? ', spoken in the demo voice' : ' (text only — no voice provider configured)'}.\n\n` +
        'They can now send a voice note to this number and the advisor answers. TRAVEL REMOVE takes them off again.'
      );
    }

    default:
      return HELP;
  }
}
