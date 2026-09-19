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
import {
  SETTINGS,
  findSetting,
  isClearing,
  override as settingOverride,
  setOverride as setSetting,
  clearOverride as clearSetting,
  clearAll as clearSettings,
} from './settings.js';
import { getSpendSummary } from '../spend.js';
import { listConsents, consentMode } from './consent.js';
import { formatUsd } from '../usage.js';

const SLOT_WORDS = { ears: 'stt', hearing: 'stt', brain: 'llm', model: 'llm', voice: 'tts', speech: 'tts' };

// "voice" and "model" each name two things: which provider, and which voice
// or model within it. Both readings are what someone means at different
// moments, and they never collide in practice — a provider id is one of a
// closed set of three, a voice id is not. So the value decides: a known
// provider switches the slot, anything else sets the dial. The other slot
// words have no such dial and say so instead of guessing.
const SLOT_WORD_DIALS = { voice: 'voice', speech: 'voice', model: 'model' };

const COMMANDS = [
  { kind: 'help', re: /^travel(?:\s+(?:help|commands|\?))?$/i },
  { kind: 'status', re: /^travel\s+(?:status|health)$/i },
  { kind: 'mode_on', re: /^travel\s+on$/i },
  { kind: 'mode_off', re: /^travel\s+off$/i },
  { kind: 'log', re: /^travel\s+(?:log|recent|calls)$/i },
  // Slot first so "travel voice elevenlabs" is a pin, not an invite.
  { kind: 'pin', re: /^travel\s+(ears|hearing|brain|model|voice|speech)\s+(\S+)$/i },
  { kind: 'unpin', re: /^travel\s+(?:defaults|unpin|reset\s+providers)$/i },
  { kind: 'settings', re: /^travel\s+(?:settings|options|config)$/i },
  // "set" is optional: "travel length 90" reads better on a phone than
  // "travel set length 90", and both should work.
  { kind: 'consents', re: /^travel\s+consents$/i },
  { kind: 'metrics', re: /^travel\s+(?:metrics|numbers|stats)(?:\s+(\d{1,3}))?$/i },
  { kind: 'review', re: /^travel\s+review(?:\s+(\d{1,2}))?$/i },
  { kind: 'reviewed', re: /^travel\s+reviewed\s+(r[a-z0-9]+)\s+(ok|good|bad|wrong)(?:\s+([\s\S]+))?$/i },
  { kind: 'sweep', re: /^travel\s+(?:sweep|retention)$/i },
  { kind: 'handoffs', re: /^travel\s+(?:handoffs|escalations|humans?)$/i },
  // The number is greedy and ends on a digit, so "+34 600 111 222 Le llamo"
  // splits after the last digit rather than after the first six.
  { kind: 'say', re: /^travel\s+say\s+(\+?[\d\s()-]{5,}\d)\s*[:—-]?\s+(\S[\s\S]*)$/i },
  { kind: 'take', re: /^travel\s+(?:take|takeover)\s+(\+?[\d\s()-]{6,})$/i },
  { kind: 'resume', re: /^travel\s+(?:resume|release|handback)\s+(\+?[\d\s()-]{6,})$/i },
  { kind: 'set', re: /^travel\s+(?:set\s+)?(voice|voiceid|language|lang|idioma|langue|length|words|effort|thinking|model|text|retry|limit|rate|tier|consent|cap|sample)\s+(.+)$/i },
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
    // The raw value, not lowercased: findProvider folds case itself, and a
    // voice id like JBFqnCBsd6RMkjVDRZzb does not survive being flattened.
    if (kind === 'pin') return { kind, slot: SLOT_WORDS[match[1].toLowerCase()], word: match[1].toLowerCase(), provider: match[2] };
    if (kind === 'set') return { kind, setting: findSetting(match[1]), value: match[2].trim() };
    if (kind === 'invite') return { kind, number: match[1].trim(), language: normalizeLanguage(match[2]) };
    if (kind === 'guest_remove') return { kind, number: match[1].trim() };
    if (kind === 'say') return { kind, number: match[1].trim(), text: match[2].trim() };
    if (kind === 'metrics') return { kind, days: match[1] ? Number(match[1]) : 7 };
    if (kind === 'review') return { kind, count: match[1] ? Number(match[1]) : 3 };
    if (kind === 'reviewed') return { kind, id: match[1], verdict: /^(ok|good)$/i.test(match[2]) ? 'ok' : 'bad', note: (match[3] || '').trim() };
    if (kind === 'take' || kind === 'resume') return { kind, number: match[1].trim() };
    return { kind };
  }
  return null;
}

const HELP = `Travel advisor — what you can send from this number:

TRAVEL STATUS — what is live, and today's spend
TRAVEL ON / OFF — talk to the advisor from this line, or stop
TRAVEL INVITE <number> [es|fr|en] — let someone try it, and send them a spoken hello
TRAVEL GUESTS — who is invited
TRAVEL METRICS [days] — per language: answers, cost, wrong language, ungrounded, codes, handoffs; cost per resolved conversation
TRAVEL REVIEW [n] — the next sampled conversations for you to read
TRAVEL REVIEWED <id> ok|bad [note] — your verdict on one
TRAVEL SWEEP — apply the retention clocks now
TRAVEL HANDOFFS — conversations waiting for a person
TRAVEL SAY <number> <message> — answer a caller yourself, from the advisor's number
TRAVEL TAKE <number> — take a conversation over; the advisor goes quiet on it
TRAVEL RESUME <number> — hand it back to the advisor
TRAVEL CONSENTS — who has seen the AI notice and what they answered
TRAVEL CONSENT required|notice|off — ask before hearing voice, only disclose, or neither
TRAVEL REMOVE <number> — take someone off the list
TRAVEL EARS|BRAIN|VOICE <provider> — switch one mid-demo
TRAVEL SETTINGS — every dial and what it is on
TRAVEL <dial> <value> — turn one, e.g. TRAVEL LENGTH 90
TRAVEL DEFAULTS — undo every switch and dial
TRAVEL LOG — the last few conversations

Translation (anyone talking to the advisor can use these):
TRANSLATE EN — everything they send comes back in English
TRANSLATE ES FR — a two-way channel between those languages
TRANSLATE OFF — back to the advisor
Works as TRADUCIR and TRADUIRE too.`;

// `voice` means a different thing per speech provider, so its value is read
// against whichever one is live right now.
function providerScope(key, described) {
  const slot = SETTINGS[key].perProvider;
  return slot ? described[slot].active : null;
}

function settingLine(key, described) {
  const spec = SETTINGS[key];
  const scope = providerScope(key, described);
  const pinned = settingOverride(key, scope);
  if (pinned !== undefined) {
    return `${spec.label}: ${format(pinned)} (set here)`;
  }
  const fromEnv = spec.envName ? (process.env[spec.envName] || '').trim() : '';
  if (fromEnv) return `${spec.label}: ${fromEnv} (configured)`;
  if (spec.describeDefault) return `${spec.label}: ${spec.describeDefault}`;
  // Nothing set anywhere: show what the code will actually do, which for the
  // provider-scoped dials means asking the live provider.
  if (scope) {
    const live = listProviders(spec.perProvider).find((p) => p.id === scope);
    if (live && typeof live.voice === 'function') return `${spec.label}: ${live.voice()} (${scope}'s default)`;
  }
  return `${spec.label}: ${format(spec.fallback)}`;
}

function format(value) {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return String(value);
}

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
    maskNumber = (n) => n,
    handoffs = null,
    metrics = null,
    review = null,
    sweep = null,
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
        `consent: ${consentMode()}`,
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
      if (!provider) {
        const dial = SLOT_WORD_DIALS[command.word];
        if (dial) return runTravelCommand({ kind: 'set', setting: dial, value: command.provider }, deps);
        return `No such provider "${command.provider}". Options: ${options}.`;
      }
      if (!provider.configured()) return `${provider.label} has no key set, so pinning it would break the next answer. Options with a key: ${listProviders(command.slot).filter((p) => p.configured()).map((p) => p.id).join(', ') || 'none'}.`;
      setOverride(command.slot, provider.id);
      const what = { stt: 'Ears', llm: 'Brain', tts: 'Voice' }[command.slot];
      return `${what}: ${provider.label}${typeof provider.model === 'function' ? ` (${provider.model()})` : ''}. Takes effect on the next message. TRAVEL DEFAULTS puts it back.`;
    }

    case 'unpin': {
      // Everything back: the provider pins and the dials together, because
      // "defaults" on a phone means all of it, not a category someone has to
      // remember the boundary of.
      const had = Object.keys(allOverrides()).length;
      clearOverrides();
      clearSettings();
      const described = describeProviders();
      return `Back to the configured defaults — ears ${described.stt.active}, brain ${described.llm.active}, voice ${described.tts.active}, and every dial reset.${
        had ? '' : ''
      }`;
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

    case 'settings': {
      const described = describeProviders();
      return ['Travel advisor dials — send TRAVEL <name> <value> to change one:']
        .concat(Object.keys(SETTINGS).map((key) => `  ${settingLine(key, described)}`))
        .concat(['', 'TRAVEL DEFAULTS puts every one of them back.'])
        .join('\n');
    }

    case 'set': {
      if (!command.setting) return `No such dial. Send TRAVEL SETTINGS for the list.`;
      const spec = SETTINGS[command.setting];
      const described = describeProviders();
      const scope = providerScope(command.setting, described);

      if (isClearing(command.value)) {
        clearSetting(command.setting, scope);
        return `${spec.label} is back to the configured default — now ${settingLine(command.setting, described).split(': ').slice(1).join(': ')}.`;
      }

      let parsed;
      try {
        parsed = spec.parse(command.value);
      } catch (err) {
        return `${spec.label} ${err.message}. It takes: ${spec.help}.`;
      }

      // A voice belongs to a speech provider, and pinning one while no
      // provider is live would be setting a dial on nothing.
      if (spec.perProvider && !scope) {
        return `No ${spec.perProvider === 'tts' ? 'speech' : spec.perProvider} provider is configured, so there is nothing to set a ${spec.label} on.`;
      }

      setSetting(command.setting, parsed, scope);
      const where = scope ? ` for ${scope}` : '';
      return `${spec.label}${where}: ${format(parsed)}. Takes effect on the next message.`;
    }

    case 'metrics': {
      if (!metrics) return 'Metrics are unavailable here.';
      const m = metrics(command.days);
      const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
      const usd = (v) => (v === null || v === undefined ? '—' : formatUsd(v));
      const line = (name, b) =>
        `${name}: ${b.answered} answered (${b.voice} voice), ${usd(b.costPerAnswer)}/answer, ${b.avgLatencyMs ? `${(b.avgLatencyMs / 1000).toFixed(1)}s` : '—'}, wrong language ${pct(b.wrongLanguageRate)}, ungrounded ${pct(b.ungroundedRate)}, codes flagged ${pct(b.entityIssueRate)}, handoffs ${b.handoffs}, failed ${b.failed}`;
      return [
        `Last ${m.days} days — ${m.conversations} conversations, ${m.resolvedConversations} resolved, ${usd(m.costPerResolvedConversation)} per resolved conversation, ${formatUsd(m.total.costUsd)} in all.`,
        line('es', m.languages.es),
        line('fr', m.languages.fr),
        line('en', m.languages.en),
        `review: ${m.reviewQueue} waiting for you, ${m.reviewed} done. TRAVEL REVIEW reads the next.`,
      ].join('\n');
    }

    case 'review': {
      if (!review) return 'Review is unavailable here.';
      const items = review.queue(command.count);
      if (!items.length) return 'Nothing waiting for review. The sample rate is TRAVEL SAMPLE <percent>.';
      return items
        .map((item) => {
          const flags = Object.keys(item.flags || {});
          return [
            `${item.id} · ${item.at.slice(0, 16).replace('T', ' ')} · ${item.language || '?'}${item.voice ? ' · voice' : ''}${flags.length ? ` · flags: ${flags.join(', ')}` : ''}`,
            `Q: ${item.transcript.slice(0, 300)}`,
            `A: ${item.reply.slice(0, 500)}`,
          ].join('\n');
        })
        .concat([`Reply TRAVEL REVIEWED <id> ok|bad [note].`])
        .join('\n\n');
    }

    case 'reviewed': {
      if (!review) return 'Review is unavailable here.';
      const done = review.mark(command.id, command.verdict, command.note);
      return done ? `${command.id}: ${command.verdict}${command.note ? ` — ${command.note}` : ''}. Recorded.` : `No sampled turn ${command.id} is waiting.`;
    }

    case 'sweep': {
      if (!sweep) return 'The sweep is unavailable here.';
      const removed = sweep();
      return `Retention applied: ${removed.conversations} conversations, ${removed.reviewItems} review items and ${removed.auditLines} audit lines removed.`;
    }

    case 'handoffs': {
      if (!handoffs) return 'Handoffs are unavailable here.';
      const open = handoffs.list();
      const who = handoffs.numbers();
      const head = who.length ? `Handoffs go to ${who.length} number${who.length === 1 ? '' : 's'}.` : 'WARNING: nobody is on the escalation list — set TRAVEL_VOICE_ESCALATION_NUMBERS.';
      if (!open.length) return `${head} No conversation is waiting for a person.`;
      return [head, `${open.length} waiting for a person:`]
        .concat(open.map((h) => `  +${h.number} (${h.language || '?'}) since ${h.openedAt.slice(11, 16)} — ${h.by}: ${h.reason || ''}${h.forwarded.length ? ` · ${h.forwarded.length} message${h.forwarded.length === 1 ? '' : 's'} since` : ''}`))
        .concat(['', 'TRAVEL SAY <number> <message> answers; TRAVEL RESUME <number> hands back.'])
        .join('\n');
    }

    case 'say': {
      if (!handoffs) return 'Handoffs are unavailable here.';
      await handoffs.say(command.number, command.text);
      return `Sent to ${command.number} from the advisor's number. The advisor stays quiet on that conversation until TRAVEL RESUME ${command.number}.`;
    }

    case 'take': {
      if (!handoffs) return 'Handoffs are unavailable here.';
      await handoffs.take(command.number);
      return `${command.number} is yours. They have been told a person is on it. TRAVEL SAY ${command.number} <message> answers them; TRAVEL RESUME ${command.number} hands back.`;
    }

    case 'resume': {
      if (!handoffs) return 'Handoffs are unavailable here.';
      const closed = await handoffs.resume(command.number);
      return closed ? `${command.number} is back with the advisor, and has been told.` : `${command.number} was not with a person.`;
    }

    case 'consents': {
      const rows = listConsents(maskNumber);
      const mode = consentMode();
      if (!rows.length) return `Consent is ${mode}. Nobody has been shown the AI notice yet.`;
      return [`Consent is ${mode}. ${rows.length} shown the AI notice:`]
        .concat(rows.map((r) => `  ${r.number} ${r.consent || 'no answer yet'}${r.consentAt ? ` (${r.consentAt.slice(0, 16).replace('T', ' ')})` : ''}${r.language ? ` ${r.language}` : ''}`))
        .join('\n');
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
