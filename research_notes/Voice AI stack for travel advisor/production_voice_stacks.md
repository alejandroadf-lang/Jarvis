# Production Voice-AI Stacks as of 2026: Vendors, Models, Orchestration and Travel Deployments

**METHODOLOGY CAVEAT — READ FIRST.** This research ran behind a network egress proxy that **blocked direct page fetches to nearly every primary vendor domain**: `livekit.com`, `www.assemblyai.com`, `poly.ai`, `elevenlabs.io`, `openai.com`, `www.cognigy.com`, `www.phocuswire.com` all returned `EGRESS_BLOCKED`. Every finding below therefore comes from **search-engine result summaries of those pages, not from reading the pages themselves**. URLs are recorded so the report-writer can re-verify, but no claim below should be treated as primary-source-verified. Where a figure originates from a comparison blog, benchmark aggregator or SEO-style listicle rather than the vendor, I say so inline. Several search results also surfaced arXiv identifiers that do not correspond to plausible real preprints (e.g. `arxiv.org/pdf/2603.05413`, `arxiv.org/pdf/2606.26114`, `arxiv.org/pdf/2603.21682`); I have **excluded all of them** as likely hallucinated or spoofed index entries. Anything dated 2025 or earlier is marked *(historical)*.

---

## Q1: Which STT, TTS and LLM products are actually deployed by the best-known voice companies and voice-agent platforms? Name the model versions.

### Takeaway
The 2026 production consensus is a small, named set of components: **Deepgram Nova-3** or **AssemblyAI Universal-3.5 Pro** / **Speechmatics Melia** for STT; **ElevenLabs Flash v2.5**, **Cartesia Sonic-3/3.5** or **Deepgram Aura-2** for TTS; **OpenAI GPT-4.1-mini / GPT-5-mini** or **Claude Sonnet 4.5** for the LLM; with **OpenAI `gpt-realtime-2.1`**, **Azure Voice Live** and **Gemini Live** as the native speech-to-speech alternatives. I could not verify most vendors' *own* statements of what they run internally — the component lists below are mostly third-party recommendation, not vendor disclosure.

### Cited Findings

**STT**
- Deepgram **Nova-3** is described as the leading production STT choice for 2026, with **AssemblyAI Universal-3 Pro** preferred where multilingual or diarization matters — [AssemblyAI, "The voice AI stack for building agents in 2026"](https://www.assemblyai.com/blog/the-voice-ai-stack-for-building-agents) (surfaced via search; page itself blocked). *Note: this is AssemblyAI's own blog recommending a competitor's STT, which is unusual and should be re-checked.*
- Deepgram **Nova-3** added **Spanish, French and Portuguese** support, delivering "double-digit relative WER reductions compared to Nova-2 across all three languages," with **streaming WER improvements exceeding 20%** for Portuguese and Spanish specifically — [Deepgram, "Deepgram Expands Nova-3 with Spanish, French, and Portuguese Support"](https://deepgram.com/learn/deepgram-expands-nova-3-with-spanish-french-and-portuguese-support). This is a **vendor-published relative improvement, not an absolute WER**; no baseline numbers were obtainable.
- **AssemblyAI Universal-3.5 Pro** handles **18 languages with native code-switching in a single pass**, explicitly including English, Spanish, French, German, Italian, Portuguese, Arabic, Danish, Dutch, Finnish, Hebrew, Hindi, Japanese, Mandarin, Norwegian, Swedish, Turkish, Vietnamese — "no language-pair parameter and no separate routing step" — [AssemblyAI, "Multilingual speech-to-text in 2026"](https://www.assemblyai.com/blog/multilingual-speech-to-text-api).
- AssemblyAI claims **Universal-3 Pro Streaming** holds "#1 English benchmark among non-open-source models and #1 across multilingual benchmarks overall" — [AssemblyAI multilingual voice agents solution page](https://www.assemblyai.com/solutions/voice-agents-multilingual-global-support). **This is marketing self-assessment**; the benchmark is not named.
- **Speechmatics "Melia"** is a multilingual STT model with **native code-switching across all 55+ supported languages in a single pass**, no per-language model selection — [Speechmatics, "Speechmatics vs AssemblyAI"](https://www.speechmatics.com/how-we-compare/assemblyai-alternative). **This is a competitive-comparison page written by Speechmatics**; its claim that Speechmatics "consistently outperforms AssemblyAI" and the G2 accuracy-in-noise figures (90% vs 80%) are vendor-selected and directly contradicted by AssemblyAI's own #1 claim above.
- Deepgram claims **Nova-3 >95% accuracy in production** on Scottish, Irish, Northern English, Australian and Indian English accents — [Deepgram, "Best Voice AI Agents 2026 Buyer's Guide"](https://deepgram.com/learn/best-voice-ai-agents-2026-buyers-guide). Vendor marketing; test set not disclosed.

**TTS**
- **ElevenLabs Flash v2.5**: ~**75 ms** on its real-time path, **32 languages** including French and Spanish — [ElevenLabs, "Meet Flash"](https://elevenlabs.io/blog/meet-flash) and [ElevenLabs Models docs](https://elevenlabs.io/docs/overview/models). Note the 75 ms figure is *model inference*, not time-to-first-audio over a network.
- Independent-ish benchmark (run by a TTS vendor, Gradium, so **not neutral**): **ElevenLabs Flash v2.5 = 288 ms P50 TTFA**; **Cartesia Sonic-3 = 188 ms P50** with a 100 ms IQR; **Rime Mist-v3 and Rime Arcana show high variance "unsuitable for real-time voice agents"** — [Gradium TTS Latency Benchmark 2026](https://gradium.ai/content/tts-latency-benchmark-2026). Treat the Rime verdict as a competitor's characterisation.
- **Cartesia Sonic 3.5** streams first audio in **75–90 ms over WebSocket from US-East** — [Cartesia vs ElevenLabs](https://www.cartesia.ai/vs/cartesia-vs-elevenlabs). Vendor-published, single egress region.
- **Deepgram Aura-2**: **313 ms P50 TTFA on the Coval benchmark**, **7 languages** (English, Spanish, French, German, Dutch, Italian, Japanese) over WebSocket streaming — reported via [TextToLab Deepgram pricing summary](https://texttolab.com/blog/deepgram-pricing) citing the Coval benchmark. Secondary source.
- **ElevenLabs** claims **95+ languages** with regional accent variants for synthesis (a larger number than the 32 quoted for Flash v2.5 — the two figures apply to different model tiers and should not be conflated) — [Deepgram buyer's guide](https://deepgram.com/learn/best-voice-ai-agents-2026-buyers-guide); ElevenLabs' own agents page quotes **"over 32 languages"** for the Agents product — [ElevenLabs Agents](https://elevenlabs.io/agents).

**LLM**
- Recommended production defaults for 2026: **OpenAI GPT-4.1-mini** as the default voice-agent LLM, **Claude Sonnet 4.5** where long context matters — [AssemblyAI voice AI stack](https://www.assemblyai.com/blog/the-voice-ai-stack-for-building-agents).
- **Parloa** (enterprise contact-centre platform) uses **GPT-4.1 and GPT-5-mini** — specifically to *simulate* realistic customer interactions pre-launch, then evaluates with **LLM-as-a-judge combined with deterministic rules** — [OpenAI customer story: Parloa](https://openai.com/index/parloa/) (page blocked; summary only). This is one of the few **vendor-confirmed model-version disclosures** found.
- **Cresta** AI Agent uses a **sub-agent architecture with human-in-the-loop supervision** across channels — [Cresta, "Decagon vs Sierra"](https://cresta.com/guides/decagon-vs-sierra). Cresta's own competitive page.
- **Decagon** uses **"Agent Operating Procedures" (AOPs)** defined in plain English, with an AOP Copilot and a pre-production simulations feature — [Parloa, "Decagon alternatives"](https://www.parloa.com/knowledge-hub/decagon-alternatives/). Competitor-authored.

**Native speech-to-speech models**
- **OpenAI `gpt-realtime`** GA'd for production voice agents; **`gpt-realtime-2.1`** shipped ~**July 2026** adding better alphanumeric recognition, silence/noise handling and interruption behaviour; **`gpt-realtime-2.1-mini`** is a distilled *reasoning* model for realtime voice with tool use — [OpenAI, "Introducing gpt-realtime"](https://openai.com/index/introducing-gpt-realtime/); [TechTimes, 7 July 2026](https://www.techtimes.com/articles/319860/20260707/openai-realtime-api-cuts-voice-agent-latency-25-adds-reasoning-mini-model.htm).
- **Azure AI Voice Live API** — **"Voice Live for Foundry Prompt Agents is generally available as of Build 2026"**; bundles VAD, echo cancellation, noise suppression, semantic turn detection and avatar streaming behind one API — [Microsoft, "Azure Speech at Build 2026"](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/azure-speech-at-build-2026-powering-voice-agents-with-real-time-and-life-like-ex/4524638); [Voice Live API overview, Microsoft Learn](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live).
- **Google Gemini Live API** — low-latency bidirectional audio/video; Google's own documented production pattern is **LiveKit + Gemini Live with an Orchestrator agent routing to specialised sub-agents** — [Google Cloud, Gemini Live API overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api).

### Inferences
- The market has converged on a **component menu rather than a single stack**: STT and TTS are commoditised and swappable, and the differentiation has moved to orchestration, evaluation and integration.
- Rime and Bland appear far less often in production-architecture discussions than ElevenLabs, Cartesia and Deepgram — consistent with, but not proof of, lower enterprise adoption.
- Parloa's use of GPT-5-mini *for simulation* suggests enterprise platforms increasingly run **two model tiers**: a cheap fast model in the live path, a stronger model offline for synthetic-traffic testing and QA scoring. That pattern is directly transferable to a travel advisor.

### Gaps
- **No vendor stated, on a page I could verify, which STT/TTS it runs in its own hosted agent product.** ElevenLabs Agents' default ASR and LLM, Vapi's defaults, and Retell's internal stack are all unverified.
- Sierra's underlying models are not disclosed in any source found; all Sierra information came from competitor-authored comparison pages (Cresta, Parloa).
- No information found on SoundHound's or Observe.AI's 2026 model versions.
- Amazon (Nova Sonic / Connect) did not surface in any search result; I have **no 2026 evidence** on Amazon's voice-agent stack.

---

## Q2: Which orchestration layer — cascade, streaming framework, or native speech-to-speech — and what do engineering blogs say about why?

### Takeaway
The stated 2026 default is **cascade (STT → LLM → TTS) with aggressive stage-overlapped streaming**, reserving native speech-to-speech for cases where conversational naturalness is the product; a **hybrid** (S2S for chit-chat, cascade for tool-calling turns) is described as the pattern production agents are converging on. Cascade wins on controllability and tool-use reliability; S2S wins on raw latency.

### Cited Findings
- LiveKit's position: end-to-end latency with **native speech-to-speech (OpenAI Realtime, Gemini 2.5 Live) is 320–800 ms**, versus higher for cascade; realtime models avoid "serialization and deserialization of audio into text and back" and avoid hand-offs between specialised models — [LiveKit, "Pipeline vs. Realtime — Which is the better Voice Agent Architecture?"](https://livekit.com/blog/realtime-vs-cascade) (page blocked; search summary).
- Cascade latency "compounds across the stack: STT + LLM time-to-first-token + TTS time-to-first-audio + network overhead," but modern pipelines **stream partial STT transcripts to the LLM while the user is still speaking and feed LLM tokens into TTS as they arrive** — this streaming overlap is "what makes competitive latency possible" — [LiveKit, same](https://livekit.com/blog/realtime-vs-cascade); [LiveKit, "Voice agent architecture: STT, LLM and TTS pipelines explained"](https://livekit.com/blog/voice-agent-architecture-stt-llm-tts-pipelines-explained).
- Human-perception thresholds cited: **under ~300 ms feels human; over 600 ms callers revert to touch-tone; over 1.5 s they hang up** — [LiveKit, realtime-vs-cascade](https://livekit.com/blog/realtime-vs-cascade). These are **assertions without a cited study** in the summary I received.
- Stated recommendation: "**Default to cascade (STT→LLM→TTS); reach for speech-to-speech only where naturalness is the product. Hybrid — S2S for chit-chat, cascade for tool-calls — is the 2026 pattern most production agents converge on**" — [LiveKit, realtime-vs-cascade](https://livekit.com/blog/realtime-vs-cascade), echoed by [Softcery, "Real-Time vs Turn-Based Voice Agents 2026"](https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture).
- **Pipecat** (open source, built and maintained by **Daily**) targets "fast, interruptible, back-and-forth voice conversations with an LLM with **sub-500 ms latency**, transcript inspection, and **mid-stream function calling**" — [Pipecat GitHub](https://github.com/pipecat-ai/pipecat); [Pipecat docs](https://docs.pipecat.ai/overview/introduction). **Pipecat Cloud** is the managed deployment with autoscaling and built-in observability — [Daily, Pipecat Cloud](https://www.daily.co/products/pipecat-cloud/).
- Framework-selection write-up comparing **Bedrock vs Vertex vs LiveKit vs Pipecat** as the four production choices — [WebRTC.ventures, March 2026](https://webrtc.ventures/2026/03/choosing-a-voice-ai-agent-production-framework/).
- **Azure Voice Live** takes the opposite architectural bet — a fully managed "batteries included" single API bundling STT, TTS, turn detection and interruption handling, rather than a composable pipeline — [Microsoft Learn, Voice Live overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live).
- Cross-provider work exists to adapt **Gemini Live to the OpenAI Realtime wire protocol**, implying the Realtime API surface is becoming a de-facto interface standard — [Zylos Research, 19 July 2026](https://zylos.ai/research/2026-07-19-realtime-voice-api-protocol-adaptation/).

### Inferences
- For a **travel/GDS advisor**, the cascade/hybrid recommendation is the relevant one: the workload is tool-call-heavy (availability, fare rules, PNR retrieval), which is precisely the case the sources say cascade handles better. The ~1.5–2 s end-to-end figure reported for Realtime (see Q4) is also *worse* than well-tuned cascade despite the theoretical S2S advantage, further favouring cascade.
- A **WhatsApp voice-note** workload is asynchronous, not full-duplex — barge-in and sub-300 ms turn latency matter far less than transcription accuracy and tool correctness. That materially weakens the case for a native S2S model in this specific product.

### Gaps
- I could not read any of the LiveKit posts directly; the latency bands (320–800 ms S2S) are unverified and no measurement methodology was obtainable.
- **No named production users of Pipecat were found.** The only claims are sector-level ("telecom, telehealth, emergency response, financial infrastructure") with no company names.
- No engineering blog from ElevenLabs, Vapi or Retell explaining their own orchestration choice was reachable.

---

## Q3: What do published customer case studies in travel, airlines, hotels and OTAs actually run?

### Takeaway
Two genuinely substantive, numbers-bearing travel voice deployments surfaced — **PolyAI at Hopper** (OTA) and **PolyAI at Golden Nugget** (hotels/casinos). Airline-side evidence is much weaker: **Lufthansa (Cognigy)** and **Iberia (ChatGPT/OpenAI)** are real but are **chat/self-service, not clearly voice**. Amadeus, Sabre, Booking, Expedia, Accor and Marriott show **infrastructure and agentic-booking activity but no verifiable production voice agent**.

### Cited Findings

**OTA / travel**
- **Hopper** (OTA, airlines + hotels + homes + cars, travellers in 100+ countries) uses **PolyAI** for phone support. PolyAI **fully resolves 15% of Hopper's call volume**, 24/7. Hopper's VP of Customer Experience is quoted as targeting **"resolution over containment"** — i.e. explicitly rejecting containment rate as the KPI — [PolyAI, Hopper case study](https://poly.ai/case-studies/hopper) (page blocked; search summary).

**Hotels**
- **Golden Nugget (Landry's) Hotels & Casinos**: PolyAI voice assistant **handles 34% of all calls to the central reservations line**, equivalent to **~3 days of agent time per week**; within **two months of launch** it averaged **300+ completed reservations per week including secure card payment capture over the phone** — [PolyAI, Golden Nugget case study](https://poly.ai/case-studies/golden-nugget/); [PDF version via FeaturedCustomers](https://cdn.featuredcustomers.com/CustomerCaseStudy.document/polyai_golden-nugget_632425.pdf).
- PolyAI reports **containment above 50% for many deployments** generally — [PolyAI conversational AI use cases](https://poly.ai/conversational-ai/examples-and-use-cases). Vendor aggregate, no per-customer breakdown.
- **Marriott, Accor and IHG** all run a **cloud CRS built by Amadeus**; **Google AI Mode is booking Marriott directly** — [Skift, "Travel Has Started Weighing AI's Worth", 18 Aug 2026](https://skift.com/2026/08/18/travel-has-started-weighing-ais-worth/). This is *agentic booking distribution*, not a voice agent.

**Airlines**
- **Lufthansa** has a published **Cognigy (now NiCE Cognigy)** case study — [NiCE Cognigy, Lufthansa](https://www.cognigy.com/en/case-study/lufthansa) (page blocked; **I could not retrieve channel, languages, go-live date, or any metric**).
- **Lufthansa Group** runs "scalable and widely utilized Self-Service AI Agents" for **rebookings, travel info, alternative-flight search and refunds**; separately, **Swifty piloted conversational booking on Swiss International Airlines' website** with Lufthansa Innovation Hub support — [ePlaneAI](https://www.eplaneai.com/news/lufthansa-group-joins-major-airlines-in-ai-driven-aviation-transformation). Secondary trade-press source; **no evidence these are voice**.
- **Iberia** entered the **GPT Store in June 2025** *(historical)*; Iberia also runs a **dedicated WhatsApp assistant for booking management, baggage-fee calculation and flight-status monitoring**, "supported by voice assistant integrations" — [PhocusWire, "Iberia launches conversational assistant on ChatGPT"](https://www.phocuswire.com/iberia-launches-conversational-assistant-chatgpt) (blocked); [Travel And Tour World](https://www.travelandtourworld.com/news/article/n5iwiivm9wb5/). **The Iberia WhatsApp assistant is the closest published analogue to the reader's product**, but the "voice assistant integrations" phrase comes from low-quality trade-SEO press and is unverified.
- **Air France-KLM** appears only in an SEO-style roundup with no specific deployment, vendor or metric — [Travel And Tour World](https://www.travelandtourworld.com/news/article/n5iwiivm9wb5/). **Treat as no evidence.**

**GDS / infrastructure**
- **Sabre** is opening back-end systems via APIs and an agentic marketplace and **doubled its agentic API/MCP partners from 30 to 60**, "even as consumer agentic travel volumes remain small"; **Sabre with Mindtrip and PayPal shipped end-to-end agentic booking in Q2 2026** — [Skift, 18 Aug 2026](https://skift.com/2026/08/18/travel-has-started-weighing-ais-worth/).
- **Expedia, Booking.com and Amadeus have largely kept core systems closed or partner-limited**, in contrast to Sabre — [Skift, 18 Aug 2026](https://skift.com/2026/08/18/travel-has-started-weighing-ais-worth/).
- A Sabre hackathon in July 2026 was framed around **"AI, agentic, voice"** and travel's "developer access divide" — [Skift, 21 July 2026](https://skift.com/2026/07/21/sabre-hackathon-ai-agentic-voice/).
- **Amadeus Altéa and Sabre integrations require partner agreements and take 6–12 weeks to provision** — [ValueStream AI, travel voice agents guide 2026](https://valuestreamai.com/blog/ai-voice-agents-travel-hospitality-guide-2026). Secondary vendor-blog source but a **concrete, actionable planning constraint** for the reader.
- **Amadeus** published an agentic-AI-for-airlines position piece — [Amadeus newsroom, "How Agentic AI Is Transforming Airlines"](https://amadeus.com/en/newsroom/press-releases/agentic-ai-airlines-amadeus). Corporate positioning, no deployment named.

**Non-travel but structurally comparable**
- **Allegro** (e-commerce marketplace, 20M+ shoppers) deployed **ElevenLabs Agents** for delivery calls: **call success rate rose from 59% to 93%**, handling **15,000+ calls/month** — [ElevenLabs customer stories](https://elevenlabs.io/customer-stories). Vendor-published; "call success rate" is undefined.
- ElevenLabs markets **"deflecting up to 80% of inbound traffic"** for virtual call-centre agents — [ElevenLabs virtual call center agent](https://elevenlabs.io/agents/virtual-call-center-agent). **This is a marketing ceiling claim, not a measured average.**

### Inferences
- The **Hopper 15% full-resolution figure is probably the single most honest benchmark available** for a travel voice agent: it is a real OTA, the metric is resolution rather than the softer "containment," and 15% is low enough to be credible. A new travel advisor should plan around that order of magnitude, not around ElevenLabs' 80% deflection marketing.
- The **Golden Nugget 34%** figure is higher because hotel reservations are a narrow, high-intent, low-variance intent set. Airline/GDS servicing (irregular ops, fare rules, involuntary reissue) is much closer to Hopper's complexity profile.
- **No airline has a verifiably published production voice agent.** The airline activity that is real is chat/self-service and agentic distribution. This is a genuine market gap, and also a warning sign about why.

### Gaps
- **Lufthansa/Cognigy: complete blank.** Could not obtain channel, language coverage, go-live date, vendor stack or any result metric. This is the most important single gap in this section.
- **Air France-KLM, IAG/Iberia voice, Booking, Expedia: no verifiable voice deployment found.** I am explicitly reporting absence of evidence rather than inferring absence of deployment.
- No go-live dates were obtainable for the Hopper or Golden Nugget deployments (Golden Nugget's metrics are "within two months of launch" but launch date is unstated).
- No case study found where a travel company discloses its **component vendors** (STT/TTS/LLM) rather than just its platform vendor.

---

## Q4: Reported production numbers — end-to-end latency, containment/deflection, cost per minute, concurrency

### Takeaway
Advertised per-minute prices ($0.05–$0.07) are systematically **4–6x below real all-in production cost ($0.25–$0.33/min)**; native speech-to-speech is the most expensive option by a wide margin (~$0.25–$0.35/min, ~$18/hour). Containment/resolution in travel lands at **15–34%**, far below vendor marketing ceilings of 80%.

### Cited Findings

**Latency**
- Native S2S end-to-end: **320–800 ms** claimed by LiveKit — [LiveKit](https://livekit.com/blog/realtime-vs-cascade); but a practitioner guide reports **"roughly 1.5 to 2 seconds end-to-end on Realtime-2 for a short utterance,"** with WebRTC STUN RTT ~60–70 ms on a clean US connection — [Fora Soft, OpenAI Realtime production guide 2026](https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026). **These two figures directly conflict**; the practitioner number is more likely to reflect production conditions, the LiveKit number more likely to reflect best-case model latency.
- OpenAI reports **"at least a 25% reduction in p95 latency across Realtime voice models"** via improved caching with `gpt-realtime-2.1` — [OpenAI](https://openai.com/index/introducing-gpt-realtime/); [TechTimes, 7 July 2026](https://www.techtimes.com/articles/319860/20260707/openai-realtime-api-cuts-voice-agent-latency-25-adds-reasoning-mini-model.htm).
- Pipecat targets **sub-500 ms** interruptible turn latency — [Pipecat GitHub](https://github.com/pipecat-ai/pipecat).
- TTS TTFA P50: Cartesia Sonic-3 **188 ms**, ElevenLabs Flash v2.5 **288 ms**, Deepgram Aura-2 **313 ms** — [Gradium benchmark](https://gradium.ai/content/tts-latency-benchmark-2026) (competitor-run) and [TextToLab/Coval](https://texttolab.com/blog/deepgram-pricing).

**Cost per minute**
- **Raw STT + LLM + TTS component cost: $0.007–$0.091 per conversation minute** depending on model choice — [AssemblyAI voice AI stack](https://www.assemblyai.com/blog/the-voice-ai-stack-for-building-agents).
- **Deepgram Nova-3: $0.0043/min batch, $0.0077/min streaming**; **multilingual streaming billed higher at $0.0092/min PAYG** vs $0.0077 monolingual — [ConvertAudioToText, Deepgram Nova-3 pricing 2026](https://convertaudiototext.com/blog/deepgram-nova-3-explained). **Directly relevant: a Spanish/French/English agent pays the multilingual premium.**
- **Deepgram Aura-2: $0.030 per 1,000 characters ($0.027 at Growth tier)** — [TextToLab](https://texttolab.com/blog/deepgram-pricing).
- **OpenAI `gpt-realtime`: $32 / 1M audio input tokens ($0.40 cached), $64 / 1M audio output tokens** — a 20% cut vs `gpt-4o-realtime-preview` — [OpenAI](https://openai.com/index/introducing-gpt-realtime/). **`gpt-realtime-2.1-mini`: $10 / 1M audio in, $20 / 1M audio out** — [Mervin Praison, July 2026](https://mer.vin/2026/07/gpt-realtime-2-1-api-reasoning-voice-agents-and-mini-pricing/) (secondary).
- **All-in Realtime production cost ≈ $0.25–$0.35/min, ≈ $18/hour at scale** — [TokenMix, "OpenAI Realtime Voice 2026: $32 Audio, Cost and Latency Traps"](https://tokenmix.ai/blog/openai-realtime-voice-api-2026-cost-latency).
- Platform advertised rates: **Vapi $0.05/min** (platform only — STT, LLM, TTS and telephony billed separately by providers you wire in), **Retell $0.07–$0.12/min PAYG with no platform fee**, **Bland $0–$499/month tiers at $0.11–$0.14/min** — [Medium/Automation Labs, "Vapi vs Retell vs Bland in 2026: The True Cost Per Minute"](https://medium.com/@automation.labs/vapi-vs-retell-vs-bland-in-2026-the-true-cost-per-minute-578f38af3523); [Bland pricing](https://www.bland.ai/pricing).
- **Vapi production setups "commonly land around $0.30 to $0.33 per minute once the full stack is assembled"** — [Medium/Automation Labs](https://medium.com/@automation.labs/vapi-vs-retell-vs-bland-in-2026-the-true-cost-per-minute-578f38af3523). Corroborated in spirit by [Klariqo, "Why '$0.05/min' Really Costs $0.25"](https://klariqo.com/blog/voice-ai-cost-per-minute/).
- **WhatsApp Business Calling API: roughly $0.05 per minute** — [respond.io, "WhatsApp AI Voice Agents in 2026"](https://respond.io/blog/whatsapp-ai-voice-agent). Secondary; should be checked against Meta's official rate card, which I could not reach.

**Concurrency**
- **Vapi: 10 concurrent lines by default; +$10 per additional concurrent line per month** — [CloudTalk, Vapi AI pricing 2026](https://www.cloudtalk.io/blog/vapi-ai-pricing/); [Cekura](https://www.cekura.ai/blogs/vapi-ai-pricing).
- **Retell AI: "unlimited concurrent call capacity," dozens to thousands of simultaneous calls per agent** — [Retell AI](https://www.retellai.com/blog/retell-vs-bland-vs-synthflow-vs-vapi). **Vendor self-claim on a competitive-comparison page; "unlimited" should be assumed to mean "soft-limited on request."**

**Containment / deflection**
- **Hopper: 15% of call volume fully resolved** (PolyAI) — [PolyAI](https://poly.ai/case-studies/hopper).
- **Golden Nugget: 34% of central-reservations calls handled** (PolyAI) — [PolyAI](https://poly.ai/case-studies/golden-nugget/).
- **PolyAI aggregate: >50% containment "for many deployments"** — [PolyAI](https://poly.ai/conversational-ai/examples-and-use-cases).
- **Allegro: call success 59% → 93%** (ElevenLabs) — [ElevenLabs customer stories](https://elevenlabs.io/customer-stories).
- **ElevenLabs marketing: "up to 80%" inbound deflection** — [ElevenLabs](https://elevenlabs.io/agents/virtual-call-center-agent). **Marketing ceiling.**

### Inferences
- Budget **$0.25–0.35/min all-in** for a cascade agent and treat any sub-$0.10 quote as platform-fee-only. For a multilingual ES/FR/EN agent, add the Deepgram multilingual streaming premium (~+20% on STT) — though STT is a small share of total cost, so this is second-order.
- Native S2S (`gpt-realtime`) at ~$0.25–0.35/min *for the model alone* is roughly the price of an entire cascade stack. For a cost-sensitive travel advisor at volume, cascade is the economically obvious choice, reinforcing the Q2 architectural conclusion.
- The gap between PolyAI's 15–34% travel results and ElevenLabs' 80% marketing is best explained by **intent complexity**, not vendor quality. Travel servicing is at the hard end.

### Gaps
- **No published concurrency limits for ElevenLabs Agents, Deepgram, Cartesia or OpenAI Realtime** were obtainable.
- I could not verify Meta's official WhatsApp Calling API rate card.
- No production latency figures published by any *travel* deployment.
- No cost-per-resolved-conversation (as opposed to per-minute) figures found anywhere.

---

## Q5: Which vendors publish explicit Spanish and French support, and at what quality tier?

### Takeaway
Spanish and French are **first-tier** at every major vendor. The meaningful differentiators for a trilingual ES/FR/EN agent are (a) **native code-switching in a single pass** — where **Speechmatics Melia (55+ languages)** and **AssemblyAI Universal-3.5 Pro (18 languages)** are explicitly built for it — and (b) whether TTS quality in ES/FR matches EN, where at least one benchmark suggests it does not.

### Cited Findings
- **Deepgram Nova-3** added Spanish, French and Portuguese with **double-digit relative WER reduction vs Nova-2**, Spanish streaming improving **>20%** — [Deepgram](https://deepgram.com/learn/deepgram-expands-nova-3-with-spanish-french-and-portuguese-support). Spanish/French are therefore **newer and less mature than English** on Nova-3.
- **Deepgram Aura-2 TTS: 7 languages**, including Spanish and French — [TextToLab](https://texttolab.com/blog/deepgram-pricing).
- **AssemblyAI Universal-3.5 Pro: 18 languages with native mid-sentence code-switching**, Spanish and French among them, no language-pair parameter or routing step — [AssemblyAI](https://www.assemblyai.com/blog/multilingual-speech-to-text-api). AssemblyAI also publishes Spanish/French/German medical transcription work — [AssemblyAI](https://www.assemblyai.com/blog/multilingual-medical-transcription).
- **Speechmatics Melia: native code-switching across all 55+ languages in a single pass** — [Speechmatics](https://www.speechmatics.com/how-we-compare/assemblyai-alternative).
- **ElevenLabs Flash v2.5: 32 languages** including Spanish and French at the low-latency tier; ElevenLabs Agents markets **"over 32 languages"**; higher-quality (non-Flash) tiers are marketed at **95+ languages** — [ElevenLabs Flash](https://elevenlabs.io/blog/meet-flash); [ElevenLabs Agents](https://elevenlabs.io/agents); [Deepgram buyer's guide](https://deepgram.com/learn/best-voice-ai-agents-2026-buyers-guide).
- A vendor-run ELO comparison found the **largest quality gaps between providers occur in non-English languages** (+260 ELO French, +380 German, +150 Spanish for Gradium over unnamed baselines) — [Gradium](https://gradium.ai/content/best-text-to-speech-api-voice-agents). **This is a TTS vendor marketing its own model; the absolute claim is not credible, but the structural point — that ES/FR TTS quality diverges more than EN — is corroborated by the general pattern of English-first model development.**
- ElevenLabs markets **regional accent variants** as valuable specifically for global travel properties — [Deepgram buyer's guide](https://deepgram.com/learn/best-voice-ai-agents-2026-buyers-guide).

### Inferences
- For a WhatsApp advisor serving ES/FR/EN travellers, **code-switching is the requirement that actually narrows the field**: Latin-American Spanish speakers and French speakers routinely mix English travel terminology (PNR, boarding pass, layover, e-ticket). Only AssemblyAI Universal-3.5 Pro and Speechmatics Melia explicitly claim single-pass code-switching; Deepgram's multilingual mode is billed as a distinct, more expensive tier which implies a different mechanism.
- Given ES/FR on Deepgram Nova-3 are comparatively recent additions, a trilingual product should **benchmark on its own domain audio** (accented ES/FR with airline jargon and alphanumeric record locators) rather than trusting any vendor's published WER. Alphanumeric recognition is called out as a specific `gpt-realtime-2.1` improvement, which suggests it is a known industry weak point — and **PNR/record-locator capture is exactly that problem**.

### Gaps
- **No absolute WER figures for Spanish or French from any vendor.** Only relative improvements and marketing comparisons.
- No neutral, third-party ES/FR TTS quality benchmark found (every benchmark located was run by a market participant).
- No information on whether ElevenLabs Agents' ES/FR voices are available at the Flash latency tier or only at the higher-quality/higher-latency tier.

---

## Q6: What do these companies say about production failure modes — hallucination controls, human escalation, barge-in, recording and QA?

### Takeaway
There is a reasonably consistent published playbook: **defense-in-depth grounding (RAG + "check KB first" prompting + confidence-thresholded escalation)**, **guardrails enforced in the orchestration layer rather than the prompt**, **200 ms barge-in stop with 300–500 ms VAD silence threshold**, and **continuous transcript sampling for QA**. Most specific numbers come from practitioner guides rather than vendors, and one widely-repeated figure (27% → <5% hallucination) has no traceable measurement behind it.

### Cited Findings

**Hallucination control**
- "The most reliable way to prevent AI agent hallucinations in production is **defense in depth**, as no single technique — RAG, prompting, fine-tuning — covers the full failure surface of agents" — [StackAI](https://www.stackai.com/insights/prevent-ai-agent-hallucinations-in-production-environments).
- Recommended stack: **RAG grounding in verified knowledge, explicit "check knowledge base first" instructions, confidence scoring with escalation below 70%, required source citations, weekly transcript audits** — claimed to reduce hallucinations **from 27% to under 5%** — [AI Advisory Board](https://aiadvisoryboard.me/blog/ai-agent-hallucination-handling). **The 27%→5% figure has no stated measurement methodology, dataset or baseline. Treat as illustrative, not measured.**
- Gladia (an STT vendor) publishes guidance on **safety, hallucinations and guardrails for trustworthy voice agents** — [Gladia](https://www.gladia.io/blog/safety-voice-ai-hallucinations).

**Guardrails**
- "**Hard-code redlines** to prevent responses that break compliance rules, brand voice, or legal boundaries — **these rules should live outside the model and be enforced at the orchestration level**" — [Softcery, custom AI voice agents guide, updated May 2026](https://softcery.com/lab/custom-ai-voice-agents-the-ultimate-guide).
- Establish **session timeouts, maximum retries, fallback thresholds and defined SLAs** — [Softcery](https://softcery.com/lab/custom-ai-voice-agents-the-ultimate-guide).
- Microsoft publishes a dedicated practical guide to building reliable production voice agents — [Microsoft Copilot Studio blog, "How to build reliable voice agents that scale in production"](https://www.microsoft.com/en-us/copilot/blog/copilot-studio/building-reliable-voice-agents-a-practical-guide/).

**Barge-in / turn-taking**
- Recommended settings: **VAD with a 300–500 ms silence threshold**, **barge-in that stops output within 200 ms** when interrupted, **phrase endpointing for natural sentence completion**, and **progressive silence handling** — [Voiceinfra, "Voice AI Prompt Engineering"](https://voiceinfra.ai/blog/voice-ai-prompt-engineering-complete-guide).
- "Use real-time barge-in detection to pause or adapt the agent's response, and context-aware dialogue management to gracefully handle off-topic, emotional, or unexpected inputs with empathy and redirection" — [Softcery](https://softcery.com/lab/custom-ai-voice-agents-the-ultimate-guide).
- **Azure Voice Live bundles turn detection, interruption handling, echo cancellation and noise suppression into the API itself**, removing them from the developer's responsibility — [Microsoft Learn](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live).
- **`gpt-realtime-2.1` specifically improved "silence and noise handling, and interruption behaviour"** — [TechTimes, 7 July 2026](https://www.techtimes.com/articles/319860/20260707/openai-realtime-api-cuts-voice-agent-latency-25-adds-reasoning-mini-model.htm). Implies these were known weaknesses in the prior version.

**Escalation**
- "Design **'I don't know' flows, handoff triggers, and clear escalation logic**. When confidence is low, ambiguity is high, or stakes are high, hand off to a human." A cited comparison found **escalation-routing yields ~71% productivity gain versus ~30% for approval-routing** — [Softcery](https://softcery.com/lab/custom-ai-voice-agents-the-ultimate-guide). **The 71%/30% figures' underlying study is not identified; do not repeat as fact.**
- **Cresta** explicitly builds **human-in-the-loop supervision** into its sub-agent architecture — [Cresta](https://cresta.com/guides/decagon-vs-sierra).
- Hopper/PolyAI's **"resolution over containment"** framing is itself an escalation philosophy: transfer early rather than trap the caller — [PolyAI](https://poly.ai/case-studies/hopper).

**QA / recording / pre-production testing**
- "**Audit and QA every release** by regularly reviewing call transcripts, hallucination rates, and unexpected model behavior. **Sample 1–5% of agent outputs daily for human review** to catch goal drift and confident extrapolation, which guardrails miss" — [StackAI](https://www.stackai.com/insights/prevent-ai-agent-hallucinations-in-production-environments) / [Softcery](https://softcery.com/lab/custom-ai-voice-agents-the-ultimate-guide).
- **Parloa** simulates realistic customer interactions with GPT-4.1/GPT-5-mini **before an agent goes live**, then scores them with **LLM-as-a-judge plus deterministic rules** — [OpenAI, Parloa](https://openai.com/index/parloa/). This is the most concrete published pre-production QA methodology found.
- **Decagon** ships a **simulations feature for testing AI agents before production deployment**, and lets behaviour be changed and tested before rollout — [Parloa](https://www.parloa.com/knowledge-hub/decagon-alternatives/).
- **Parloa** publishes on AI tooling for contact-centre quality management — [Parloa](https://www.parloa.com/knowledge-hub/ai-tools-contact-center-quality-management/).
- **Pipecat** exposes **transcript inspection** as a first-class capability, and Pipecat Cloud ships **built-in observability** — [Pipecat GitHub](https://github.com/pipecat-ai/pipecat); [Daily](https://www.daily.co/products/pipecat-cloud/).

### Inferences
- The **simulate-then-judge pattern (Parloa, Decagon)** is the clearest emerging enterprise standard and is directly applicable to a travel advisor: generate synthetic ES/FR/EN traveller conversations covering irregular-ops scenarios, run them against the agent pre-release, score with an LLM judge plus deterministic assertions on the GDS calls actually made.
- **Guardrails belong outside the model.** For travel this is load-bearing: fare rules, change fees and ticketing conditions must be read from the GDS and rendered deterministically, never generated. Any figure the agent speaks (price, fee, time, PNR) should be a template slot filled from a tool response, not free-form LLM output.
- **Barge-in latency requirements largely do not apply to a WhatsApp voice-note product**, which is half-duplex. The reader can deprioritise this entire class of engineering and reinvest in grounding and transcription accuracy.

### Gaps
- **No vendor published its own measured hallucination rate.** All numbers are from practitioner blogs with untraceable provenance.
- **Nothing found on call recording, retention, consent or GDPR handling** for voice agents in an EU/travel context — a significant gap given the reader's Spanish/French market and PCI implications of the Golden Nugget-style payment capture.
- No published post-mortem or failure analysis from any named travel voice deployment.
- Could not verify what escalation SLA or transfer mechanism PolyAI uses at Hopper.

---

## Cross-cutting note for the report writer

The evidence base splits sharply into three tiers of reliability, and the report should not flatten them:

1. **Vendor-confirmed and specific** — PolyAI/Hopper 15%, PolyAI/Golden Nugget 34%, Deepgram Nova-3 pricing and ES/FR/PT expansion, OpenAI gpt-realtime token pricing, Azure Voice Live GA at Build 2026, AssemblyAI Universal-3.5 Pro 18-language code-switching, Parloa's GPT-4.1/GPT-5-mini simulation pipeline.
2. **Vendor marketing, unmeasured** — ElevenLabs "up to 80% deflection," Retell "unlimited concurrency," Speechmatics "consistently outperforms AssemblyAI," AssemblyAI "#1 multilingual benchmark," Gradium's ELO advantages.
3. **Practitioner-blog numbers with no traceable methodology** — the 27%→5% hallucination reduction, the 71% vs 30% escalation-routing productivity gain, the 300 ms/600 ms/1.5 s caller-behaviour thresholds, and the conflicting 320–800 ms vs 1.5–2 s Realtime end-to-end latency figures.

The **single largest unresolved question** is what Lufthansa actually deployed with Cognigy, and whether any airline anywhere runs a production voice agent. On current evidence the answer appears to be **no published airline voice deployment exists** — airlines are in chat and agentic distribution, and the voice work in travel is concentrated in OTAs (Hopper) and hospitality (Golden Nugget, Amadeus-CRS hotel groups).
