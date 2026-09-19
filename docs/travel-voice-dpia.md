# Data protection impact assessment — Travel Voice Advisor

**Status:** draft, pre-filled from the architecture as built in `server/travelVoice/`. The
sections marked *to complete* need the controller's own facts (legal entity, DPO, vendor
contracts, the privacy notice URL). Nothing here is legal advice; it is the engineering
account a DPO needs in order to give some.

**Why a DPIA:** three independent triggers apply — voice recordings of identifiable people
processed at scale through several AI vendors; systematic evaluation of what a person said
by automated means; and an innovative technology (an AI agent) talking to consumers and
professionals. Any one would be enough under GDPR Article 35(3) and the EDPB criteria.

## 1. What the processing is

A travel professional (or a consumer they invite) sends a WhatsApp voice note or text to a
business number. The audio is transcribed, an AI model answers as an Amadeus / travel-industry
advisor, the answer is synthesised as a voice note and sent back with the text. The same
number translates between Spanish, French and English on request, and can hand the
conversation to a person.

**Controller:** *to complete.* **Processor(s):** the AI and messaging vendors listed in §4.
**DPO:** *to complete.* **Privacy notice:** `TRAVEL_VOICE_PRIVACY_URL`, *to complete.*

## 2. Data, subjects, purposes

| Data | Source | Purpose | Kept |
|---|---|---|---|
| Phone number | Meta webhook | Routing, rate limit, consent record | Masked in every log; salted hash in the audit trail (`TRAVEL_VOICE_AUDIT_SALT`) |
| Voice note audio | Caller | Transcription only | Never stored by this server; sent to the transcription vendor and discarded |
| Transcript and reply | Derived | Answering; conversation memory | `TRAVEL_VOICE_RETENTION_DAYS` (180 by default), then swept |
| Conversation history | Derived | Context for the next answer | Same clock; deleted when the conversation is idle past it |
| Case memory | Derived: locators, tickets, carriers, airports, entries suggested, topic, a short note | So the caller is not asked to repeat their case after the transcript is trimmed | Same clock as the transcript; erased together with it; never in the audit trail; never holds an amount |
| Consent record | Caller's button tap | Evidence of disclosure and agreement | Until the caller withdraws (`BORRAR` / `SUPPRIMER` / `DELETE`) |
| Review sample | 1–5% of answered turns, words included | Human quality review | `TRAVEL_VOICE_REVIEW_RETENTION_DAYS` (365) |
| Audit trail | Every turn, **without words or the caller's codes** | Accountability, per-language metrics | `TRAVEL_VOICE_AUDIT_RETENTION_DAYS` (5 years) |
| Handoff record | Escalations | A person can take over | With the audit trail; numbers masked |

**Subjects:** travel agents and agency staff (professionals), and any consumer an agency
invites. **Special categories:** voice is inherently biometric-capable; this system never
derives a voiceprint, never identifies a speaker by voice, never asks a vendor for
diarisation, speaker labels, sentiment or emotion (enforced by test), and the advisor is
instructed never to infer or mention mood, health, age, gender or origin. Article 9 is
therefore not engaged by design; the DPO should confirm.

## 3. Lawful basis and transparency

- **Disclosure at first contact** (AI Act Art. 50, Meta Business Messaging policy): the
  first message from any number is met, before processing, with a spoken and a written
  notice that this is an AI, how data is handled, for how long, that a person can review it,
  and how to reach a person (`server/travelVoice/consent.js`).
- **Consent for voice** (`TRAVEL_VOICE_CONSENT=required`, the default): a voice note is not
  downloaded or transcribed until the caller taps *I agree*; the tap is stored with Meta's
  message id and timestamp. Text is answered meanwhile under legitimate interest (the CNIL
  treats conversational assistance as a legitimate-interest use *a priori*). A decline keeps
  text working. Withdrawal is one word and deletes the record and the conversation.
- **Lowering the bar** (`notice`, `off`) is a founder decision made from the phone and shown
  in `TRAVEL STATUS`; it should be used only for the founder's own demo numbers.
- **Synthetic audio** carries a machine-readable AI-generated marker inside the Ogg file
  (`TRAVEL_VOICE_MARK_AUDIO`); whether WhatsApp preserves container comments on delivery must
  be verified on the real channel, which is why the spoken disclosure exists as well.

## 4. Recipients and transfers

Each provider slot is switchable; the deployment decides. Declared residency per vendor
drives `TRAVEL_VOICE_RESIDENCY=eu`, which refuses any provider not declared EU-hosted.

| Role | Vendors available | EU option |
|---|---|---|
| Transcription | OpenAI Whisper, ElevenLabs Scribe, Deepgram Nova-3, AssemblyAI Universal | Vendor EU endpoint/project, declared with `*_RESIDENCY=eu` |
| Advisor model | Anthropic Claude, IONOS (Llama/Mistral), OpenAI, Gemini, DeepSeek, OpenRouter | IONOS (EU by construction); Claude via `ANTHROPIC_GATEWAY=bedrock|vertex` in an EU region |
| Synthesis | OpenAI, ElevenLabs (`ELEVENLABS_ZERO_RETENTION`), Deepgram Aura | As above |
| Messaging | Meta WhatsApp Business Platform | Meta is in the data path before any vendor; its residency terms are the controller's to establish |
| Live fares | Amadeus Self-Service API | Sends only route, dates, passenger count |

*To complete:* DPA and transfer mechanism (SCCs / DPF) per vendor actually enabled.

## 5. Risks and the controls in place

| Risk | Control | Where |
|---|---|---|
| Caller not told they talk to a machine | Spoken + written disclosure before any processing; version-tracked | `consent.js`, `discloseTo()` |
| Voice processed without a basis | Voice gated on a recorded button tap by default | `handleTravelVoiceMessage` |
| Data kept longer than needed | Three retention clocks, sweeper on start and daily, `TRAVEL SWEEP` | `audit.js`, `runRetentionSweep()` |
| Re-identification from logs | Numbers masked everywhere a person reads; salted hash in the trail; no words in the trail, and record locators, ticket numbers and amounts are counted rather than kept — the trail outlives the transcript, so it must not hold what retrieves a PNR | `maskNumber`, `callerKey`, `recordAudit` |
| Automated decision with legal effect | The advisor gives guidance, never a decision on entitlement; a person with override authority is one word away and can answer or take over | `escalation.js`, `TRAVEL SAY/TAKE/RESUME` |
| Invented fares or fees | Every amount checked against tool results and the caller's words; one correction; recorded | `grounding.js` |
| Wrong language, mangled locator | Drift check with one correction; locators read back in the spelling alphabet; codes protected through translation | `replyCheck.js`, `spoken.js`, `translate.js` |
| Inference about the person | No diarisation/sentiment requested from any vendor (tested); prompt forbids it | `providers/stt.js` tests, `advisor.js` |
| Runaway cost or abuse | Daily cap, per-conversation cap, per-caller hourly limit, guest list | `spend.js`, `audit.js`, `guests.js` |
| No human oversight of quality | 1–5% sample read by a person; per-language metrics; simulate-then-judge before release | `audit.js`, `qa/simulate.js` |
| Vendor retention | ElevenLabs asked not to log; other vendors' retention *to complete* from their DPAs | `providers/tts.js` |

## 6. Residual risk and decision

*To complete by the controller.* Points the DPO should weigh: Meta's position in the data
path; whether the chosen vendors' EU offerings are enabled and contracted; the six-month
transcript retention (chosen to match the CNIL's period for quality recordings — shorten if
the business case allows); and the review sample, which is the only place words are kept
beyond the transcript clock.

## 7. Rights

- **Access / portability:** the conversation history and consent record for a number can be
  exported from `sessions.json` and `travelVoiceConsent.json` by the operator.
- **Erasure:** the caller sends `BORRAR` / `SUPPRIMER` / `DELETE`, or the operator sends
  `TRAVEL FORGET <number>`; both clear the transcript, the case memory, the remembered
  language and any translation mode. The operator can also
  call `forgetConsent()` and `resetTravelVoiceSession()`. The audit trail keeps only the
  hash and metadata.
- **Objection to automated processing:** `AGENTE` / `CONSEILLER` / `AGENT` at any time.

## 8. Evidence

`npm run travel:smoke` walks a caller through the whole pipeline with the vendors faked —
first contact and the notice, the tap, a question carrying a locator, a question designed to
make the advisor invent a fee, a translation full of codes, a demand for a person — and
asserts on each control in this document, including that the trail holds no words, no
numbers and no locators. It needs no credentials and is the check to run before a demo or a
release. `npm run travel:qa` is the model-scored version and costs tokens.

## 9. Review

Re-run this assessment when a provider is added, when `TRAVEL_VOICE_RESIDENCY` or
`TRAVEL_VOICE_CONSENT` defaults change, when live calls (the media bridge) ship, or when the
disclosure wording changes (`DISCLOSURE_VERSION` in `consent.js` forces re-consent).
