// WhatsApp, inbound: the webhook Meta calls with every message and receipt,
// and the two paths a message can take from there (the founder's company turn,
// or the help desk for anyone else).
//
// Inbound messages. Everything here is ordered around one constraint: Meta
// wants a 200 within seconds and retries if it doesn't get one, while a team
// turn takes 20 seconds to two minutes. So this acknowledges immediately and
// answers afterwards through the Send API — see channels/whatsapp.js.
//
// This used to live inline in index.js, 390 lines inside one route handler
// running after the response had gone. Nothing in it could be tested without
// booting the whole server, and the route is the one that commits code and
// emails customers. Here it is a factory: index.js hands in the things only it
// owns (the model client, the company turn, the desk's session map, the
// deep-dive drain), and a test can hand in fakes for the network. Nothing
// about what a message does has changed in the move.

import * as whatsapp from './whatsapp.js';
import { isImage, SUPPORTED_IMAGE_TYPES } from './whatsapp.js';
import { recordInbound, recordReceipt, waitingMessage, STAGES } from './whatsappLog.js';
import { runDeskTurn as realRunDeskTurn } from './deskTurn.js';
import { parseFounderCommand, runFounderCommand } from './founderCommands.js';
import { isWhatsAppDeskEnabled } from '../realtime/supportDesk.js';
import { getPlan, approvePlan, rejectPlan, parsePlanCommand, formatPlanForWhatsApp } from '../dailyPlan.js';
import { enqueue as enqueueDeepDive } from '../deepDives.js';
import { trimHistory, saveSession } from '../sessionStore.js';
import { getIntegrationStatus } from '../integrations.js';
import { runPitchNow } from '../dailyMeeting.js';
import { dryRunOutreach } from '../outreachDryRun.js';
import { releaseDraft } from '../actionHandlers.js';
import { runFactCheck, describeFactCheck } from '../factCheck.js';
import { runEval } from '../eval/run.js';
import * as speech from '../speech.js';
import { spokenExcerpt } from '../speech.js';
import * as openai from '../agents/openai.js';
import { spokenLanguage, truncationNotice } from '../language.js';

/**
 * @param {object} deps
 * @param {object} deps.anthropic          the model client every turn uses
 * @param {Function} deps.runCompanyTurn   (sessionId, text, options) => { reply, ranOutOfTime }
 * @param {Function} deps.drainDeepDives   starts working the deep-dive queue
 * @param {Map} deps.deskSessions          help-desk histories, keyed by "desk-<number>"
 * @param {number} deps.turnDeadlineMs     how long a conversational turn gets
 * @param {object} [deps.io]               the network, for tests: sendWhatsAppMessage,
 *   sendWhatsAppAudio, downloadMedia, transcribeAudio, synthesize,
 *   isOpenAIConfigured, isSpeechConfigured, runDeskTurn
 * @returns {{ webhook: Function, handleWhatsAppMessage: Function, handleDeskMessage: Function }}
 */
export function createWhatsAppInbound({ anthropic, runCompanyTurn, drainDeepDives, deskSessions, turnDeadlineMs, io = {} }) {
  const sendWhatsAppMessage = io.sendWhatsAppMessage || whatsapp.sendWhatsAppMessage;
  const sendWhatsAppAudio = io.sendWhatsAppAudio || whatsapp.sendWhatsAppAudio;
  const downloadMedia = io.downloadMedia || whatsapp.downloadMedia;
  const transcribeAudio = io.transcribeAudio || openai.transcribeAudio;
  const isOpenAIConfigured = io.isOpenAIConfigured || openai.isOpenAIConfigured;
  const synthesize = io.synthesize || speech.synthesize;
  const isSpeechConfigured = io.isSpeechConfigured || speech.isSpeechConfigured;
  const runDeskTurn = io.runDeskTurn || realRunDeskTurn;
  const { verifySignature, extractMessage, isAllowedSender, isDuplicate, unsupportedTypeReply } = whatsapp;

  /** The route handler. Returns the handling promise, which Express ignores and tests await. */
  function webhook(req, res) {
    if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) {
      // Refused before anything is read out of the body: this endpoint is
      // public and what's behind it can commit code and email customers.
      recordInbound({ stage: STAGES.BAD_SIGNATURE });
      return res.sendStatus(403);
    }

    // Acknowledge now. Every path below this line runs after the response.
    res.sendStatus(200);

    const message = extractMessage(req.body);
    if (!message) {
      // Delivery and read receipts arrive here too. Worth counting even though
      // there's nothing to answer: they're the proof that Meta is calling this
      // webhook at all, which is the first thing in question when a message
      // seems to vanish.
      recordReceipt();
      return;
    }

    // A signature proves Meta sent it, not who typed it. The allowlist is the
    // gate that decides whose messages actually reach the company.
    if (!isAllowedSender(message.from)) {
      // A stranger. With the help desk switched on they reach it — and only
      // it: this path never parses founder commands or plan approvals and
      // never runs the company turn, so "HALT" from an unknown number is a
      // customer saying halt, not the founder. Off, they are dropped as before.
      if (isWhatsAppDeskEnabled()) {
        if (isDuplicate(message.id)) {
          recordInbound({ stage: STAGES.DUPLICATE, from: message.from, text: message.text });
          return;
        }
        return handleDeskMessage(message).catch((err) => {
          console.error('WhatsApp: the help desk failed to handle a message:', err);
        });
      }
      console.warn(`WhatsApp: ignoring a message from an un-allowlisted number (${message.from}).`);
      recordInbound({ stage: STAGES.NOT_ALLOWLISTED, from: message.from, text: message.text });
      return;
    }

    // A retried delivery must not run the turn — or fire an action — twice.
    if (isDuplicate(message.id)) {
      recordInbound({ stage: STAGES.DUPLICATE, from: message.from, text: message.text });
      return;
    }

    return handleWhatsAppMessage(message).catch((err) => {
      console.error('WhatsApp: failed to handle a message:', err);
    });
  }

  /**
   * Answers in the medium the question arrived in.
   *
   * The text always goes out. The voice note is added on top, never instead of:
   * a spoken reply carries the top of the answer and the message carries all of
   * it, and if speech fails for any reason the founder still has their answer.
   * Losing a reply to a TTS outage would be a worse bug than never having built
   * this.
   */
  async function replyToWhatsApp(message, reply, { asVoice = false, language = '' } = {}) {
    await sendWhatsAppMessage(message.from, reply);
    if (!asVoice || !isSpeechConfigured() || process.env.VOICE_REPLIES === 'false') return;

    try {
      const { text: spoken, truncated } = spokenExcerpt(reply);
      if (!spoken) return;
      // Which language is actually being spoken — which is not always the one
      // the founder used. With REPLY_LANGUAGE pinned, the text reply is in the
      // pinned language while Whisper reports what it heard, and the voice was
      // being told to speak the wrong one of the two.
      const spokenName = spokenLanguage({ detected: language });
      const body = truncated ? `${spoken} ${truncationNotice(spokenName)}` : spoken;
      const { buffer, mimeType, filename } = await synthesize(body, {
        // Saying the language back lets the voice keep the accent rather than
        // reading Spanish with an English mouth. A canonical name, never the raw
        // detection value — "Speak naturally in es" instructs nothing.
        instructions: spokenName ? `Speak naturally in ${spokenName}.` : '',
      });
      await sendWhatsAppAudio(message.from, buffer, { mimeType, filename });
    } catch (err) {
      // Deliberately quiet to the founder: they already have the answer, and a
      // second message apologising for the absence of the first would be noise.
      console.error('Could not send the spoken reply:', err.message);
    }
  }

  /**
   * What was said, whether typed or spoken.
   *
   * Shared by the founder's path and the help desk's, so a customer's voice
   * note is heard exactly the way the founder's is — same transcription, same
   * language detection, same honest replies when there was nothing to hear.
   * Transcribed here rather than inside either turn so everything downstream
   * sees an ordinary text message.
   *
   * `handled` is true when a reply has already gone out (no speech, or the
   * transcription failed) and the caller should stop.
   */
  async function hearMessage(message) {
    let text = message.text.trim();
    let spokenIn = '';
    let arrivedAsVoice = false;

    if (isVoiceNote(message) && message.mediaId && isOpenAIConfigured()) {
      try {
        const { buffer, filename } = await downloadMedia(message.mediaId);
        const heard = await transcribeAudio(buffer, filename);
        text = heard.text.trim();
        spokenIn = heard.language;
        arrivedAsVoice = true;
        if (!text) {
          recordInbound({ stage: STAGES.UNSUPPORTED_TYPE, from: message.from, detail: 'Voice note had no speech in it' });
          await sendWhatsAppMessage(message.from, "I couldn't make out any words in that one — try again?");
          return { handled: true };
        }
      } catch (err) {
        // Whoever sent it is holding their phone waiting. The reason beats silence.
        recordInbound({ stage: STAGES.FAILED, from: message.from, detail: err.message });
        await sendWhatsAppMessage(message.from, `I couldn't transcribe that voice note — ${err.message}`);
        return { handled: true };
      }
    }
    return { handled: false, text, spokenIn, arrivedAsVoice };
  }

  /**
   * A stranger's message, answered by the help desk.
   *
   * Everything the founder's path has and this one does not is deliberate:
   * no founder commands, no plan approval, no company turn, no company
   * state. The desk gets the words, its own history for this number, and
   * its two tools. The reply comes back the way it arrived — a voice note is
   * answered with a voice note, in the language it was spoken in.
   */
  async function handleDeskMessage(message) {
    const heard = await hearMessage(message);
    if (heard.handled) return;
    const { text, spokenIn, arrivedAsVoice } = heard;

    if (isImage(message) || !text) {
      await sendWhatsAppMessage(message.from, "Send a message or a voice note describing the problem and I'll help.");
      return;
    }

    const sessionId = `desk-${message.from}`;
    const history = deskSessions.get(sessionId) || [];
    const startedAt = Date.now();
    try {
      const { reply } = await runDeskTurn({
        anthropic,
        from: message.from,
        text,
        history,
        spokenIn,
        arrivedAsVoice,
        deadlineAt: Date.now() + turnDeadlineMs,
      });
      const next = trimHistory([...history, { role: 'user', content: text }, { role: 'assistant', content: reply }]);
      deskSessions.set(sessionId, next);
      saveSession('desk', sessionId, next);

      await replyToWhatsApp(message, reply, { asVoice: arrivedAsVoice, language: spokenIn });
      recordInbound({ stage: STAGES.ANSWERED, from: message.from, text, detail: 'help desk', durationMs: Date.now() - startedAt });
    } catch (err) {
      console.error('Help desk turn failed:', err);
      recordInbound({ stage: STAGES.FAILED, from: message.from, text, detail: err.message });
      await sendWhatsAppMessage(message.from, 'Something went wrong on my side. Please try again in a moment.');
    }
  }

  async function handleWhatsAppMessage(message) {
    const heard = await hearMessage(message);
    if (heard.handled) return;
    let { text } = heard;
    const { spokenIn, arrivedAsVoice } = heard;

    // A screenshot is how a founder explains something faster than they can
    // describe it — a settings page, an error, a competitor's pricing. The
    // company could not see one, so the fastest input channel they have was
    // closed to the team that works for them.
    let image = null;
    if (isImage(message)) {
      try {
        const { buffer, mimeType } = await downloadMedia(message.mediaId);
        if (!SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
          recordInbound({ stage: STAGES.UNSUPPORTED_TYPE, from: message.from, detail: `Image type: ${mimeType}` });
          await sendWhatsAppMessage(message.from, unsupportedTypeReply('image'));
          return;
        }
        image = { data: buffer.toString('base64'), mediaType: mimeType };
        // An image with no caption is still a question — "look at this" — so
        // it gets one rather than reaching the team as an empty message.
        if (!text) text = 'Have a look at this and tell me what you make of it.';
      } catch (err) {
        recordInbound({ stage: STAGES.FAILED, from: message.from, detail: err.message });
        await sendWhatsAppMessage(message.from, `I couldn't open that image — ${err.message}`);
        return;
      }
    }

    if (!text) {
      recordInbound({ stage: STAGES.UNSUPPORTED_TYPE, from: message.from, detail: `Type: ${message.type}` });
      await sendWhatsAppMessage(message.from, unsupportedTypeReply(message.type));
      return;
    }

    // Approval is decided here, before the company turn ever sees the words.
    // An agent that interprets "approve" is an agent that can conclude it was
    // approved — so the founder's reply goes straight to the function that
    // records the decision, and the team finds out by reading the plan.
    const command = parsePlanCommand(text);
    if (command) {
      try {
        if (command.kind === 'status') {
          await sendWhatsAppMessage(message.from, formatPlanForWhatsApp(getPlan()));
        } else if (command.kind === 'approve') {
          const plan = approvePlan({ note: command.note });
          recordInbound({ stage: STAGES.ANSWERED, from: message.from, text, detail: 'approved the daily plan' });
          await sendWhatsAppMessage(
            message.from,
            `Approved — ${plan.items.length} item${plan.items.length === 1 ? '' : 's'} cleared for ${plan.date}. ` +
              'Anything not on that list is still refused.'
          );
        } else {
          const plan = rejectPlan({ reason: command.reason });
          recordInbound({ stage: STAGES.ANSWERED, from: message.from, text, detail: 'rejected the daily plan' });
          await sendWhatsAppMessage(
            message.from,
            `Rejected${plan.note ? `: ${plan.note}` : ''}. Nothing runs; the team can send a revised plan today.`
          );
        }
      } catch (err) {
        await sendWhatsAppMessage(message.from, `Couldn't record that — ${err.message}`);
      }
      return;
    }

    // The founder's own controls — halt, scope grants, status — decided the
    // same way and for the same reason: these are the powers that bound
    // agents, so an agent never gets to interpret them. See
    // channels/founderCommands.js.
    const founderCommand = parseFounderCommand(text);
    if (founderCommand) {
      try {
        const reply = await runFounderCommand(founderCommand, {
          probeIntegrations: getIntegrationStatus,
          // The same function the 8am cycle calls, so PITCH shows the founder
          // tomorrow's email rather than an approximation of it.
          runPitch: () => runPitchNow({ anthropic }),
          // The rehearsal needs a model client for the CEO review, and it is
          // the same one every agent turn uses — a dry run against a different
          // client would be rehearsing a different company.
          dryRunOutreach: (args) => dryRunOutreach({ ...args, anthropic }),
          // Releasing a draft runs the ordinary send path, gates and all — the
          // founder's yes is an extra opinion on the message, never a way past
          // the allowlist.
          releaseDraft: (id) => releaseDraft(id, { anthropic }),
          // Started, not awaited: the eval takes minutes of real API calls, and
          // holding the webhook open for it would time out long before it
          // finished. The result finds the founder when it exists.
          // Same shape as the eval and for the same reason: it takes minutes of
          // real calls and the webhook would time out long before it finished.
          startFactCheck: () => {
            runFactCheck({ anthropic })
              .then((result) => sendWhatsAppMessage(message.from, describeFactCheck(result)))
              .catch((err) => sendWhatsAppMessage(message.from, `The fact check could not finish — ${err.message}`))
              .catch((sendErr) => console.error('Could not deliver the fact check:', sendErr));
          },
          startEval: (scenarioId) => {
            runEval({ scenarioId })
              .then(({ summary }) => sendWhatsAppMessage(message.from, `Eval finished.\n\n${summary}`))
              .catch((evalErr) => sendWhatsAppMessage(message.from, `The eval could not finish — ${evalErr.message}`))
              .catch((sendErr) => console.error('Could not deliver the eval result:', sendErr));
          },
        });
        recordInbound({ stage: STAGES.ANSWERED, from: message.from, text, detail: `founder command: ${founderCommand.kind}` });
        await replyToWhatsApp(message, reply, { asVoice: arrivedAsVoice, language: spokenIn });
      } catch (err) {
        // A mistyped venture id is the common case, and the founder needs to
        // see which one it was rather than a generic failure.
        await sendWhatsAppMessage(message.from, `Couldn't do that — ${err.message}`);
      }
      return;
    }

    // Acknowledge before thinking. A real turn takes minutes — the CEO asks
    // around before replying — and from a phone that is indistinguishable from
    // the thing being broken, which it has been more than once. The estimate is
    // the median of turns that actually completed, so it is a measurement
    // rather than a number someone guessed and never revisited.
    //
    // Failing to acknowledge must never cost the answer: if this send fails the
    // turn still runs, and the reply carries its own send attempt.
    if (!ackDisabled()) {
      try {
        await sendWhatsAppMessage(message.from, waitingMessage());
      } catch (err) {
        console.warn(`WhatsApp: could not send the acknowledgement: ${err.message}`);
      }
    }

    const startedAt = Date.now();
    try {
      // The sender's number is the session key, so a WhatsApp conversation has
      // its own continuous history rather than colliding with the web app's.
      const { reply, ranOutOfTime } = await runCompanyTurn(`whatsapp-${message.from}`, text, {
        deadlineAt: Date.now() + turnDeadlineMs,
        image,
        spokenIn,
        arrivedAsVoice,
      });

      if (ranOutOfTime) {
        // The question was bigger than the clock. Send what the team has, say
        // plainly that it is the quick version, and queue the real one —
        // rather than letting a rushed answer pass for a considered one.
        const dive = enqueueDeepDive({
          question: text,
          sessionId: `whatsapp-${message.from}`,
          deliverTo: message.from,
          reason: 'ran past the conversational deadline',
        });
        await sendWhatsAppMessage(
          message.from,
          `${reply}\n\n— That's the quick read; the question was bigger than the two minutes I give a chat reply. ` +
            'The team is working it through properly now and I\'ll send the full answer when it lands.'
        );
        drainDeepDives();
        recordInbound({
          stage: STAGES.ANSWERED,
          from: message.from,
          text,
          detail: `answered briefly; queued ${dive.id} for the full version`,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      await replyToWhatsApp(message, reply, { asVoice: arrivedAsVoice, language: spokenIn });
      recordInbound({
        stage: STAGES.ANSWERED,
        from: message.from,
        text,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      // The founder asked a question and is waiting on their phone. Silence is
      // the worst possible answer, so the real reason goes back to them — the
      // spend cap and a missing key both produce something actionable.
      //
      // Recorded before the apology is sent, because the send is the other
      // thing that fails here and it would otherwise take the reason with it.
      // The elapsed time goes in too: a config error that fails instantly and a
      // turn that ran for four minutes and then broke are different problems,
      // and the message alone does not tell them apart.
      const elapsed = Date.now() - startedAt;
      recordInbound({ stage: STAGES.FAILED, from: message.from, text, detail: err.message, durationMs: elapsed });
      try {
        await sendWhatsAppMessage(
          message.from,
          `The team couldn't answer that — ${err.message}\n\n(Failed after ${Math.round(elapsed / 1000)}s.)`
        );
      } catch (sendErr) {
        // Both the answer and the apology failed. Nothing reaches the phone, so
        // the log is the only record there is — say so where it will be read.
        console.error(
          `WhatsApp: could not deliver the failure to ${message.from} either: ${sendErr.message}. ` +
            `Original failure: ${err.message}`
        );
      }
    }
  }

  // Some people would rather have silence than a message every time they ask
  // something. Off by default because not knowing whether it is working has
  // cost more than an extra line ever will.
  function ackDisabled() {
    return (process.env.WHATSAPP_ACK_DISABLED || '').trim().toLowerCase() === 'true';
  }

  function isVoiceNote(message) {
    return message.type === 'audio' || message.type === 'voice';
  }

  return { webhook, handleWhatsAppMessage, handleDeskMessage };
}
