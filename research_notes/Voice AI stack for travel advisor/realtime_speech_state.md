# Real-Time / Streaming Speech Technology, State of the Art as of Q3 2026

> **Method note that applies to every finding below.** In this environment `WebFetch` was blocked by the network egress proxy for every vendor, arXiv, HuggingFace and docs domain I tried (pipecat.ai, deepgram.com, livekit.com, docs.livekit.io, arxiv.org, huggingface.co, assemblyai.com all returned `EGRESS_BLOCKED`). All numbers below therefore come from **search-index summaries of the cited pages**, not from direct reads of the pages themselves. Each URL is the page the number is attributed to, and I have flagged where I could not confirm the number against the primary source. Treat any single figure as "reported by that page" rather than "verified by me." Where a figure is a vendor's own claim I say so explicitly; where it is from an independent evaluator (Coval, Artificial Analysis, academic work) I say so too.

---

## Q1. The three architectures and their actual end-to-end latency

### Takeaway
A cascade, a streaming cascade ("streaming voice agent") and a native speech-to-speech model are not three points on a latency line so much as three different failure surfaces: a *non-streaming* cascade lands in seconds, a *well-tuned streaming* cascade lands around 600 ms–1.2 s voice-to-voice, and native speech-to-speech has a floor around 300–500 ms time-to-first-audio but in independent measurement often lands at 0.7–3 s depending on how much "thinking" it does. The dominant term in both streaming architectures is LLM time-to-first-token, not the speech parts.

### Cited Findings

**Architecture definitions and where each is used**
- The three-way split is STT→LLM→TTS cascade, streaming/pipelined cascade with turn detection, and end-to-end speech-to-speech; "most 2026 production voice agents are cascaded, though speech-to-speech is growing fast for short conversational use cases where latency dominates and the tool surface is shallow" — [Gradium, Cascaded Voice Agents vs Speech-to-Speech: Architecture Tradeoffs in 2026](https://gradium.ai/content/cascaded-voice-agent-vs-speech-to-speech-2026)
- Deepgram's own framing of the same split (vendor with an interest in cascades) — [Deepgram, Speech-to-Speech vs Cascade](https://deepgram.com/learn/speech-to-speech-vs-cascade-voice-agent-architecture)
- Modulate argues the cascade wins for enterprise specifically on auditability, not latency — [Modulate, Beat the Black Box](https://www.modulate.ai/ebooks/beat-the-black-box-why-cascade-beats-speech-to-speech-for-enterprise-voice-agents)

**Stage-by-stage latency budget for a streaming cascade**
- "A typical cascaded pipeline spends 100–300 ms on speech-to-text, 350–1,000 ms on LLM inference, 90–200 ms on text-to-speech, and 50–200 ms on network round trips, totaling 600 ms to 1.7 seconds" — [Gradium 2026 architecture comparison](https://gradium.ai/content/cascaded-voice-agent-vs-speech-to-speech-2026)
- A near-identical budget from a second source: "STT 100–300 ms, LLM TTFT 200–600 ms, TTS first-audio 150–400 ms, network 20–100 ms, orchestration 20–50 ms" — [Future AGI, How to Optimize Pipecat Voice Agent Latency in 2026](https://futureagi.com/blog/how-to-optimize-pipecat-latency-2026/)
- A worked Pipecat example over WebRTC from a laptop to a cloud agent: "280 ms in speech-to-text, 600 ms waiting for the LLM to start generating, 320 ms before the first audio reached the speaker, and 200 ms of transport overhead," with an LLM TTFT target of 650 ms — [Future AGI Pipecat latency guide](https://futureagi.com/blog/how-to-optimize-pipecat-latency-2026/)
- LiveKit-stack numbers: "STT takes about 100–200 ms, LLM adds 300–500 ms with streaming, TTS takes about 100–200 ms, and network adds 50–150 ms with WebRTC… practical target ~700 ms–1.2 s end-to-end" — [Forasoft, Build and Deploy LiveKit AI Voice Agents: The 2026 Playbook](https://www.forasoft.com/blog/article/livekit-ai-agents-guide)
- LiveKit internal testing of Deepgram Nova-2 → GPT-4o → ElevenLabs Turbo v2.5 gave "average end-to-end latency of 750 ms – 900 ms" (this is a **historical** stack; Nova-2, GPT-4o and Turbo v2.5 are all superseded) — reported via [Forasoft LiveKit guide](https://www.forasoft.com/blog/article/livekit-ai-agents-guide), originating from [LiveKit, Understand and Improve Agent Latency](https://livekit.com/blog/understand-and-improve-agent-latency) (could not fetch the LiveKit original)

**Native speech-to-speech latency**
- "Speech-to-speech systems have a typical floor of 300–500 ms time-to-first-audio, while cascaded systems typically fight to clear 500 ms" — [Gradium 2026 architecture comparison](https://gradium.ai/content/cascaded-voice-agent-vs-speech-to-speech-2026)
- Same source: measured benchmarks show S2S "around 85% lower latency versus a non-streaming cascade, though against a well-optimized streaming cascade that gap shrinks substantially but doesn't disappear" — [Gradium](https://gradium.ai/content/cascaded-voice-agent-vs-speech-to-speech-2026)
- Counter-claim from the same body of work: "a well-engineered cascaded pipeline, where TTS streams first audio in roughly 100–250 ms, can actually beat some end-to-end speech-to-speech models on voice-to-voice latency" — [Gradium](https://gradium.ai/content/cascaded-voice-agent-vs-speech-to-speech-2026)
- Independent TTFA measurements on the Artificial Analysis speech-to-speech leaderboard (Big Bench Audio as the stimulus set): Grok Voice Think Fast 2.0 High at **0.70 s TTFA**; Gemini 3.1 Flash Live from **0.96 s at minimal reasoning effort to 2.99 s at high reasoning effort** (as of 30 Aug 2026) — [Artificial Analysis, Speech to Speech](https://artificialanalysis.ai/speech-to-speech) and [Artificial Analysis speech-to-speech methodology](https://artificialanalysis.ai/methodology/speech-to-speech-benchmarking)

**Perceived-latency thresholds used as design targets (see Q6 for the evidence behind them)**
- "Under 300 ms feels human, 300–600 ms feels sluggish but acceptable, above 600 ms callers revert to touch-tone mental models…, above 1.5 s they hang up" — [Forasoft LiveKit guide](https://www.forasoft.com/blog/article/livekit-ai-agents-guide)
- P95 turn-latency SLOs by use case: "500 ms for sales and support, 800 ms for general conversational flow, 1200–1500 ms for clinical or complex tool turns" — [Future AGI, How to Measure Voice AI Latency: The Complete 2026 Guide](https://futureagi.com/blog/how-to-measure-voice-ai-latency-2026/)

### Inferences
- The reader's current setup — WhatsApp *voice notes* through a batch cascade — is not on this spectrum at all. A voice note is an asynchronous file: there is no turn-taking, no barge-in, and the latency budget is bounded by upload + full-file STT + full LLM completion + full TTS synthesis, i.e. seconds to tens of seconds. Moving to a "streaming voice agent" is not a tuning change; it requires a real-time *transport* (Q7), which for WhatsApp means the Business Calling API (Q7 note).
- Because LLM TTFT (200–1,000 ms) dominates every published cascade budget, the cheapest large latency win in a cascade is a faster/smaller LLM or speculative first-sentence generation, not swapping STT or TTS vendors. Vendors compete loudly on the 90 ms TTS number that is ~10% of the budget.
- The Artificial Analysis TTFA spread (0.70 s to 2.99 s for native S2S) contradicts the clean "S2S floor = 300–500 ms" narrative. The 300–500 ms figure appears to describe the *model's* audio-generation floor, not the end-to-end API round trip a developer measures.

### Gaps
- I could not retrieve the Pipecat public benchmark page ([pipecat.ai/benchmarks](https://www.pipecat.ai/benchmarks)) or the LiveKit latency post directly; both are the canonical first-party breakdowns and should be read before quoting any stage figure as authoritative.
- No source gave a *matched-conditions* head-to-head (same hardware, same network, same prompt) of a streaming cascade versus a native S2S model measured voice-to-voice. Every comparison I found is either vendor-framed or compares different stimulus sets.

---

## Q2. Native speech-to-speech models available in 2026

### Takeaway
As of September 2026 the native S2S field has three serious hosted players (Google Gemini 3.8 Live, OpenAI gpt-realtime-2.x, Amazon Nova 2 Sonic) plus open-weight options (Moshi/Kyutai, Qwen3-Omni, Step-Audio 3). Google's September 2026 release leads independent quality rankings and is also the cheapest of the hosted three; the open models are dramatically cheaper and lower-latency but well behind on reasoning and tool use.

### Cited Findings

**Google — Gemini 3.8 Live and 3.8 Live Extended Thinking (released 15 Sep 2026)**
- Released 15 September 2026; native speech-to-speech over the Gemini Live API on a WebSocket session; accepts audio, video, images and text, returns audio — [Google blog, Introducing Gemini 3.8 Live and 3.8 Live Extended Thinking](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-8-live-gemini-3-8-live-extended-thinking/); [DataCamp, Gemini 3.8 Live](https://www.datacamp.com/blog/gemini-3-8-live)
- **97 supported languages** with in-conversation switching and claimed accent consistency (Google's claim) — [DataCamp](https://www.datacamp.com/blog/gemini-3-8-live)
- Pricing **$0.005/min audio input, $0.018/min audio output**, ≈ **$1.38/hour** of conversation, described as under half the cost of OpenAI's competing realtime model — [Pasquale Pillitteri, Google Launches Gemini 3.8 Live](https://pasqualepillitteri.it/en/news/16547/gemini-3-8-live-audio-model). Note a conflicting figure: another source reports **$0.84/hour**, calling it the cheapest model on the Artificial Analysis index — [MarkTechPost, Google Releases Gemini 3.8 Live](https://www.marktechpost.com/2026/09/15/google-releases-gemini-3-8-live-and-3-8-live-extended-thinking-for-production-grade-voice-agents/). **These two hourly figures disagree; verify against Google's pricing page.**
- Quality (independent): **#1 on Artificial Analysis Speech-to-Speech Quality Index at 82.6** for the Extended Thinking variant — [MarkTechPost](https://www.marktechpost.com/2026/09/15/google-releases-gemini-3-8-live-and-3-8-live-extended-thinking-for-production-grade-voice-agents/)
- Tool use (independent, Sierra's τ-Voice): **68.6% on τ-Voice** vs 37.7% for the previous generation; **35.1% on τ-Voice-banking**; **97.7% on Big Bench Audio** — [MarkTechPost](https://www.marktechpost.com/2026/09/15/google-releases-gemini-3-8-live-and-3-8-live-extended-thinking-for-production-grade-voice-agents/); [BeInCrypto, Gemini 3.8 Live speech benchmark](https://beincrypto.com/gemini-3-8-live-speech-benchmark/)
- Architectural fix that matters for agents: **asynchronous function calling** — tool/API calls execute in the background while audio keeps streaming; in the previous generation a webhook call froze the audio generator until it returned — [MarkTechPost](https://www.marktechpost.com/2026/09/15/google-releases-gemini-3-8-live-and-3-8-live-extended-thinking-for-production-grade-voice-agents/); [daily.dev summary](https://daily.dev/posts/gemini-3-8-live-thinks-in-the-background-while-you-talk-and-the-benchmarks-are-hard-to-ignore-vqety7y4w)
- Model card — [Google DeepMind, Gemini 3.8 Audio model card](https://deepmind.google/models/model-cards/gemini-3-8-audio/)
- **Historical:** Gemini 2.5 Flash Live and Gemini 3.1 Flash Live are the superseded generations; 3.1 Flash Live's measured TTFA ranged 0.96–2.99 s by reasoning effort — [Artificial Analysis](https://artificialanalysis.ai/speech-to-speech); [Google Cloud docs, Gemini 2.5 Flash with Live API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api)

**OpenAI — gpt-realtime-2 / gpt-realtime-2.1 (and mini)**
- **128K token context window, up to 32K output tokens**; supports function calling **but not structured outputs** — [OpenAI API docs, GPT-Realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1); [Vercel AI Gateway model page](https://vercel.com/ai-gateway/models/gpt-realtime-2.1)
- Pricing: **$32/M audio input tokens, $64/M audio output tokens** for GPT Realtime 2.1; **$10/M and $20/M** for the mini — [eesel, GPT Realtime Mini pricing 2026](https://www.eesel.ai/blog/gpt-realtime-mini-pricing)
- Token-to-time conversion: "bills exactly 1 audio token per 100 ms of user speech and 1 per 50 ms of model speech: **$0.0192/min to listen, $0.0768/min to speak**" — [Synthorai, GPT Live API Pricing](https://synthorai.io/blog/gpt-realtime-api-pricing/). Independent-ish measurement across 4,000 sessions: "**$0.06–$0.11/min** on gpt-realtime-2.1 and **$0.02–$0.05/min** on mini once prompt caching is working; without caching long calls can reach **$0.18–$0.46/min**" — [HackerNoon, OpenAI Realtime API Pricing in 2026: Real-World Data From 4,000 Measured Sessions](https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions)
- Known weaknesses reported by developers: structured outputs unsupported, so a chained path is advised "when a strict structured intermediate contract is required"; one report of function calling failing with input contexts under 10,000 tokens — [DEV, OpenAI GPT-Realtime-2 Complete Voice API Developer Guide (2026)](https://dev.to/akaranjkar08/openai-gpt-realtime-2-complete-voice-api-developer-guide-2026-aj6); [benchr.org, GPT-Realtime-2.1 review](https://benchr.org/articles/gpt-realtime-2-1-review); [OpenAI community, Context Limitations in Real-Time API](https://community.openai.com/t/context-limitations-in-real-time-api/1116690)
- Cost grows with call length because the whole audio conversation stays in context — [Gradium](https://gradium.ai/content/cascaded-voice-agent-vs-speech-to-speech-2026)
- **Historical:** gpt-4o-realtime-preview (2024) and the original `gpt-realtime` GA model (Aug 2025) are superseded by the gpt-realtime-2.x line.

**Amazon — Nova Sonic / Nova 2 Sonic**
- Nova 2 Sonic: **$3/M speech input tokens, $12/M speech output tokens, ≈$0.015/min**, described as ~80% cheaper than OpenAI's GPT-4o Realtime (a **historical** comparison baseline) — [llm-stats, Nova 2 Sonic](https://llm-stats.com/models/nova-2-sonic)
- Nova 2 Sonic adds polyglot voices, **seven languages including Portuguese and Hindi**, asynchronous tool calling, cross-modal voice/text switching, and a **1M token context window** — [llm-stats](https://llm-stats.com/models/nova-2-sonic); [Ry Walker, AWS Nova 2 Sonic](https://rywalker.com/research/aws-nova-2-sonic)
- Original Nova Sonic supported expressive voices in **English, Spanish, French, Italian, German** — [AWS, Amazon Nova speech](https://aws.amazon.com/ai/generative-ai/nova/speech); [AWS Bedrock model card, Nova Sonic](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-sonic.html)
- Customer-reported latency improvement (vendor case study, so treat as marketing): "82% reduction in average latency, with maximum latency of 2 seconds instead of 7 seconds, and minimum latency of 300 ms instead of 2 seconds" — [AWS Roojoom case study](https://aws.amazon.com/solutions/case-studies/roojoom-case-study/)
- Stated weaknesses: less granular control over intermediate steps than a chained approach; narrower language/feature set than mature separate services — [Caylent, Introducing Amazon Nova Sonic](https://caylent.com/blog/introducing-amazon-nova-sonic)

**Open-weight models**
- **Moshi (Kyutai)**: theoretical latency **160 ms** (80 ms Mimi frame + 80 ms acoustic delay), practical **~200 ms on an L4 GPU**; 7B dual-stream architecture; ships a complete serving stack; full-duplex by construction — [Kyutai Moshi paper, arXiv:2410.00037](https://arxiv.org/abs/2410.00037); [GitHub kyutai-labs/moshi](https://github.com/kyutai-labs/moshi); [Krzysztof Sopyła, Speech-to-Speech Models in 2026](https://ai.ksopyla.com/posts/voice-to-voice-models-2026-review/)
- **Qwen3-Omni**: end-to-end audio-to-audio **≈702 ms** measured through the DashScope cloud API (not self-hostable in that configuration); supports function calling via `tool_call` XML tags — [Krzysztof Sopyła review](https://ai.ksopyla.com/posts/voice-to-voice-models-2026-review/); [GitHub QwenLM/Qwen3-Omni](https://github.com/QwenLM/Qwen3-Omni)
- **Step-Audio 3 Realtime**: technical report published 2026; earlier Step-Audio described as a 130B-parameter model with incremental audio output under Apache-2.0 — [Step-Audio 3 Realtime Technical Report, arXiv:2609.14005](https://arxiv.org/html/2609.14005); [Sopyła review](https://ai.ksopyla.com/posts/voice-to-voice-models-2026-review/)
- **xAI Grok Voice** is now a measured entrant: Grok Voice Think Fast 2.0 High at **0.70 s TTFA, 97% speech reasoning, 94.7% task success** on Artificial Analysis as of 30 Aug 2026 — [Artificial Analysis](https://artificialanalysis.ai/speech-to-speech)

### Inferences
- For a Spanish/multilingual travel advisor, Gemini 3.8 Live's 97-language coverage and Nova 2 Sonic's 7-language coverage are very different propositions; OpenAI's realtime line sits in between (it inherits broad multilingual ability from the base model but voice quality varies by language — I found no published per-language table).
- Async function calling (Gemini 3.8 Live, Nova 2 Sonic) is the feature that makes native S2S viable for a *travel advisor* specifically, because such an agent is tool-heavy (availability lookups, pricing). Before async tool calls, every lookup stalled the audio stream — which is exactly the failure mode that makes a cascade look better.
- Open-weight S2S (Moshi) has the best raw latency numbers of anything published, but Moshi is a conversational demo model, not an instruction-following agent; nobody in the sources proposes it for tool-using production agents.

### Gaps
- No reliable per-language quality or WER data for any native S2S model. Vendors publish language *counts*, not per-language error rates.
- The two Gemini 3.8 Live hourly-cost figures ($1.38/hr vs $0.84/hr) conflict and I could not reach Google's pricing page to resolve it.
- I found no published context-window figure for Gemini 3.8 Live's audio session, nor a documented session-duration limit for any of the three hosted models (session caps have historically been a hard operational constraint — e.g. the older OpenAI Realtime session limits — but I could not confirm current values).
- Step-Audio 3's actual latency figures are in arXiv:2609.14005, which I could not fetch.

---

## Q3. Streaming ASR products: published latency and WER

### Takeaway
Streaming ASR has bifurcated into "fast transcript" models (~100–300 ms to partials/finals) and "conversational" models that bundle end-of-turn detection into the ASR itself (Deepgram Flux, AssemblyAI Universal-3.5 Pro Realtime). The accuracy/latency trade-off is real and currently contested: AssemblyAI publishes a large WER advantage over Flux on the Pipecat agent benchmark, while Deepgram publishes a large turn-detection latency advantage.

### Cited Findings

**Deepgram**
- **Nova-3** (general streaming): **6.84% median WER streaming, 5.26% batch**; **31 languages** for real-time multilingual — [Future AGI / Coval-derived comparison](https://futureagi.com/blog/speech-to-text-apis-in-2026-benchmarks-pricing-developer-s-decision-guide/); [Deepgram model docs](https://developers.deepgram.com/docs/model)
- **Flux** (conversational STT with built-in turn detection): vendor claim of **median end-of-turn detection latency under 300 ms, p95 at 1.5 s**; "doesn't rely on silence thresholds, it models conversational context directly" — [Deepgram, Introducing Flux](https://deepgram.com/learn/introducing-flux-conversational-speech-recognition)
- Vendor claim: Flux reduces agent response latency by **200–600 ms** versus traditional STT+VAD — [Deepgram Flux announcement](https://deepgram.com/learn/introducing-flux-conversational-speech-recognition)
- Vendor claim: Flux Multilingual is "up to 3× lower latency than competing real-time end-of-turn systems"; **10 languages** with an optional `language_hint` — [Deepgram Flux Multilingual discussion](https://github.com/orgs/deepgram/discussions/1603)
- **Independent (Coval)**: Flux achieves "50% lower latency to first token and faster turn detection" with no accuracy trade-off — [Deepgram citing Coval](https://deepgram.com/learn/coval-validates-flux-no-tradeoff-between-latency-and-interruption). Note this is Deepgram's page *about* an independent result; Coval's own benchmark repo is at [github.com/coval-ai/benchmarks](https://github.com/coval-ai/benchmarks/blob/main/docs/methodology.md)
- Pricing: **Nova-3 monolingual $0.0048/min streaming, multilingual $0.0058/min; Flux English $0.0065/min, Flux Multilingual $0.0078/min** — [DIY AI, Deepgram Pricing 2026](https://diyai.io/ai-tools/speech-to-text/deepgram-pricing-2026/); [Deepgram pricing](https://deepgram.com/pricing)
- Deepgram publishes a methodology for measuring streaming STT latency — [Deepgram docs, Measuring STT Latency](https://developers.deepgram.com/docs/measuring-streaming-latency)

**AssemblyAI**
- **Universal-Streaming**: vendor claim of **immutable transcripts in ~300 ms**, "41% faster median latency than competing solutions like Deepgram Nova-3" — [AssemblyAI, Introducing Universal-Streaming](https://www.assemblyai.com/blog/introducing-universal-streaming); [AssemblyAI Universal-Streaming product page](https://www.assemblyai.com/universal-streaming)
- **Universal-3.5 Pro Realtime**: reported **6.99% pooled WER on the Pipecat agent benchmark versus Flux's 15.58%**; end-of-turn detection "reads tonality, pacing and rhythm and lands around 300 ms"; three modes — `min_latency`, `balanced`, `max_accuracy` — [ChatGate, AssemblyAI Universal-3 Pro Streaming](https://chatgate.ai/post/assemblyai-universal-3-pro-streaming); tuning docs at [AssemblyAI, Optimizing Accuracy and Latency](https://www.assemblyai.com/docs/streaming/getting-started/optimizing-accuracy-and-latency)
- **Direct conflict to flag:** the 6.99% vs 15.58% Flux WER gap comes from a page favourable to AssemblyAI, while Deepgram cites Coval saying Flux has no accuracy trade-off. These cannot both be the whole story — they are probably measuring different things (pooled agent-speech WER vs. turn-level accuracy) on different datasets. Do not present either as settled.

**Soniox**
- **stt-rt-v5**: **1.34% semantic WER**, **260 ms median time to final segment** (305 ms P95, 313 ms P99) — [Soniox benchmarks](https://soniox.com/benchmarks)
- 2025 study across 60 languages on real-world YouTube audio: **6.5% WER English for Soniox vs 9.3% for Speechmatics** (Soniox's own comparison page, so vendor-framed) — [Soniox vs Speechmatics](https://soniox.com/compare/soniox-vs-speechmatics/english)
- Streams token by token with refinements, manual finalization and endpoint detection; no on-device or air-gapped option — [Speechmatics comparison page](https://www.speechmatics.com/how-we-compare/soniox-alternative)

**Gladia**
- **Solaria-1**: **103 ms partial transcript latency, 270 ms final transcript latency**; positioned on multilingual coverage and automatic code-switching — [Gladia, Best Speech-to-Text APIs in 2026](https://www.gladia.io/blog/best-speech-to-text-apis); [Gladia vs Speechmatics](https://www.gladia.io/blog/speechmatics-vs-gladia)

**Speechmatics**
- Streams in larger segments, which "can feel slower for live use cases" (competitor's characterisation); differentiator is **on-device and fully air-gapped deployment** for regulated/edge workloads — [Speechmatics vs Soniox](https://www.speechmatics.com/how-we-compare/soniox-alternative)
- I found **no first-party published millisecond latency figure** for Speechmatics realtime; one source explicitly says "specific latency benchmarks should be confirmed directly with the vendor."

**Whisper-based streaming**
- Whisper is architecturally hostile to streaming: the encoder only processes 30-second chunks, so a naive 1-second-latency streaming implementation zero-pads to 30 s and re-runs the encoder every second — "for 1 minute of streaming inference, this leads to at least 60 audio encoder forward passes, equivalent to up to 30 minutes of processed audio" — [Adapting Whisper for Streaming Speech Recognition via Two-Pass Decoding, arXiv:2506.12154](https://arxiv.org/pdf/2506.12154)
- With the LocalAgreement-2 policy used by `whisper_streaming`, "the average computationally unaware latency is approximately twice the chunk size" — [Turning Whisper into Real-Time Transcription System, arXiv:2307.14743](https://arxiv.org/pdf/2307.14743); [GitHub ufal/whisper_streaming](https://github.com/ufal/whisper_streaming)
- Practical consumer-hardware reality: "latency is 5–10 seconds minimum on consumer hardware" for a chunk-and-stitch streaming pipeline — [SayToWords, Real-Time Streaming with Whisper (2026)](https://www.saytowords.com/blogs/Real-Time-Streaming-with-Whisper)
- Throughput reference: RTX 4090 with faster-whisper + FlashAttention-2 reaches 70–100× real-time on short clips, ~8× on long files; RTX 3090 lands at 3–5× — [RunAIHome, Self-Host Whisper Large-v3 in 2026](https://runaihome.com/blog/whisper-large-v3-self-hosted-transcription-server-2026/)
- On-device streaming Whisper is a live research area — [WhisperKit, arXiv:2507.10860](https://arxiv.org/pdf/2507.10860)

**Independent benchmarking infrastructure**
- Artificial Analysis launched a dedicated streaming STT benchmark, **AA-WER Streaming** — [Artificial Analysis, New Streaming Speech to Text Benchmark](https://artificialanalysis.ai/articles/new-streaming-speech-to-text-benchmark-aa-wer-streaming); leaderboard at [artificialanalysis.ai/speech-to-text/streaming](https://artificialanalysis.ai/speech-to-text/streaming); methodology at [artificialanalysis.ai/speech-to-text/methodology](https://artificialanalysis.ai/speech-to-text/methodology)
- Coval's STT benchmark: **897 conversational clips** from spontaneous voice-agent speech, model-generated reference transcripts, loudness-normalised to −20 dBFS RMS with peak guarding, deterministic selection from frozen sources, Apache-2.0 runner code — [Coval methodology](https://github.com/coval-ai/benchmarks/blob/main/docs/methodology.md); [Coval, Best STT Providers 2026](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/)

### Inferences
- The meaningful metric for a voice agent is not transcript latency but **time-to-end-of-turn**, because that is what gates the LLM call. Flux and Universal-3.5 Pro Realtime both fold turn detection into ASR precisely to remove the serial VAD-silence wait (typically several hundred ms — see Q5).
- Whisper-family streaming is effectively disqualified for a sub-second interactive agent unless heavily re-architected (two-pass decoding, WhisperKit-style on-device). It remains fine for the reader's *current* async voice-note cascade, where a 5–10 s transcription is invisible to the user.
- WER numbers are only comparable within one benchmark. Nova-3's 6.84% (general streaming corpus) and Universal-3.5's 6.99% (Pipecat *agent speech* corpus) are not the same measurement.

### Gaps
- No first-party Speechmatics realtime latency number found.
- No current published WER for Deepgram Flux from Deepgram itself; only the disputed third-party 15.58% figure.
- Coval's and Artificial Analysis's actual leaderboard tables could not be read (fetch blocked), so I have provider-level claims but not the full ranked tables.

---

## Q4. Low-latency TTS: published time-to-first-byte/first-audio

### Takeaway
Vendor TTFB claims cluster at 40–90 ms; independent P50 measurements of the same products cluster at 180–320 ms. The gap is methodological (vendors measure synthesis-start to first chunk on warm local paths; independent benchmarks include network and leading silence), and the *variance* (IQR, tail) matters more for conversational feel than the median.

### Cited Findings

**Vendor claims**
- **Cartesia Sonic-3**: **40 ms TTFA** claimed; **Sonic-3.6** (state-space model rather than transformer) claims **sub-90 ms TTFA** and leads both Artificial Analysis speech arenas — [MarkTechPost, Cartesia Ships Sonic-3.6](https://www.marktechpost.com/2026/08/18/cartesia-ships-sonic-3-6-a-streaming-tts-model-that-now-leads-both-artificial-analysis-speech-arenas/); [CodeSOTA, ElevenLabs vs Cartesia Sonic](https://www.codesota.com/speech/elevenlabs-vs-cartesia)
- **ElevenLabs Flash v3**: **~75 ms** claimed (July 2026) — [Gradium TTS Latency Benchmark 2026](https://gradium.ai/content/tts-latency-benchmark-2026)
- **Deepgram Aura-2**: **90 ms optimized TTFB**, sub-200 ms baseline, **p95 TTFB under 200 ms** — [Deepgram, How We Took Aura-2's TTFB from <200 ms to 90 ms](https://deepgram.com/learn/engineering-real-time-low-latency-voice-ai-at-scale); [Deepgram, Introducing Aura-2](https://deepgram.com/learn/introducing-aura-2-enterprise-text-to-speech)
- **Rime Mist v3**: **~37 ms P50 on H100** — [Dograh, TTS Time-to-First-Byte Compared for Voice Agents](https://www.dograh.com/feeds/blog/tts-time-first-byte)
- Summary position: "Cartesia, Deepgram, Rime, and ElevenLabs Flash v2.5 all publish sub-100 ms TTFB, with Cartesia and Rime leading at sub-50 ms" — [Dograh](https://www.dograh.com/feeds/blog/tts-time-first-byte)

**Independent measurements (same products, different numbers)**
- **ElevenLabs Flash v2.5: 288 ms P50 (28 ms IQR)** — [Gradium TTS Latency Benchmark 2026](https://gradium.ai/content/tts-latency-benchmark-2026)
- **Cartesia Sonic-3: 188 ms P50 with a 100 ms IQR** — [Gradium](https://gradium.ai/content/tts-latency-benchmark-2026)
- **Deepgram Aura-2: 313 ms P50 (68 ms IQR)** — [Gradium](https://gradium.ai/content/tts-latency-benchmark-2026)
- Rime Arcana, ElevenLabs Multilingual v2 and OpenAI tts-1-hd "show high variance unsuitable for real-time voice agents" — [Gradium](https://gradium.ai/content/tts-latency-benchmark-2026)
- Coval's explicit warning that vendor TTS benchmarks are not comparable and its TTFA definition: **TTFA = (first audio chunk arrival − synthesis start) + leading silence inside the stream before the first audible sample** — [Coval, Best TTS Providers 2026: Why Vendor Benchmarks Lie](https://www.coval.ai/blog/best-text-to-speech-providers-in-2026-how-to-choose-(and-why-vendor-benchmarks-lie)/)
- Note the definitional trap: TTFB "includes container headers that carry no audio content," which is why a vendor can report a number far below real audible latency — [Gradium](https://gradium.ai/content/tts-latency-benchmark-2026)
- Quality-vs-latency tier gap (Artificial Analysis ELO): **Sonic 3.6 at 1,288 ELO vs ElevenLabs Flash v2.5 at 1,083 ELO** — [Inworld, Best TTS APIs for Real-Time Voice Agents (2026 Benchmarks)](https://inworld.ai/resources/best-voice-ai-tts-apis-for-real-time-voice-agents-2026-benchmarks)

**OpenAI and PlayHT**
- "OpenAI does not publish official latency specifications for its standard TTS API — a meaningful gap for latency-sensitive production use cases" — [Lushbinary, Deepgram vs Cartesia vs OpenAI](https://lushbinary.com/blog/ai-voice-tts-api-comparison-deepgram-cartesia-openai/)
- **PlayHT became PlayAI after Meta's July 2025 acquisition and is reported to be winding down**; flagged as not a long-term choice for new projects — [SpeechGeneration AI, Best TTS APIs for Developers (2026)](https://speechgeneration.ai/best-ai-text-to-speech-apis). Treat this as **historical/deprecated** rather than a live option.

### Inferences
- TTS is the *least* important lever in a sub-second budget (90–320 ms out of 600–1,700 ms), but it is the one with the most misleading marketing. The right selection criterion from the Coval framing is P95/IQR under load, not headline P50.
- The ~200 ms discrepancy between vendor and independent numbers for the same models is systematic, not random — it appears in all three of ElevenLabs, Cartesia and Deepgram. Budget with the independent numbers.
- ElevenLabs Flash/Turbo tiers exist specifically to trade quality for latency; for a travel advisor where voice quality is part of the brand, the Sonic-3.6-class quality tier at sub-90 ms claimed TTFA is the interesting point on the curve.

### Gaps
- No independent P50/IQR for Rime Mist v3, Cartesia Sonic-3.6 or ElevenLabs Flash v3 — the independent table I found covers the previous generation (Flash v2.5, Sonic-3, Aura-2).
- No per-language TTFB figures; Spanish/multilingual voices may behave differently from English.

---

## Q5. Turn-taking machinery in production

### Takeaway
Production turn-taking in 2026 has moved off silence thresholds onto learned models: a fast VAD (Silero-class) gates audio, a small semantic/acoustic end-of-turn model (Pipecat Smart Turn v3, LiveKit Turn Detector, or turn detection folded into the ASR as in Flux) decides whether the user has actually finished, and a separate classifier distinguishes barge-in from backchannel. The end-of-turn stage is where several hundred milliseconds of the budget is won or lost.

### Cited Findings

**Smart Turn (Pipecat, open source)**
- Smart Turn v3: **~8M parameters**, Whisper-Tiny encoder base plus a linear classifier head, **int8 quantized**, operates on the **raw waveform, not the transcript** — [HuggingFace pipecat-ai/smart-turn-v3](https://huggingface.co/pipecat-ai/smart-turn-v3)
- Inference cost (author's claim, Kwindla Hultman Kramer): "**<60 ms on most cloud vCPUs**, faster than that on your local CPU, and **<10 ms on GPU**" — [kwindla on X, 11 Sep 2026](https://x.com/kwindla/status/1966359269080707363)
- **23 languages**, fully open source with no licence restrictions, open data and open training code — [HuggingFace smart-turn-v3](https://huggingface.co/pipecat-ai/smart-turn-v3); [GitHub pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn)
- v3 "scores the last ~8 seconds of raw waveform on pause; runs fast ONNX CPU inference and is now Pipecat's default local analyzer" — [Zylos Research, Turn-Taking and Barge-In Mechanics in Realtime Voice Agents (17 Jul 2026)](https://zylos.ai/research/2026-07-17-turn-taking-barge-in-realtime-voice-agents/)
- The ecosystem has spawned language-specific forks: Thai — [arXiv:2510.04016](https://arxiv.org/pdf/2510.04016); Tamil — [GitHub santhosh-005/tamil-eot](https://github.com/santhosh-005/tamil-eot)
- Semantic VAD with Silero + Smart Turn is being upstreamed into vLLM's realtime serving — [vllm-omni issue #7478](https://github.com/vllm-project/vllm-omni/issues/7478)

**LiveKit**
- LiveKit Turn Detector "began as a 135M-parameter text transformer reading the last four turns and predicting turn completion, dynamically extending VAD's silence window when more speech is likely" — [Zylos Research](https://zylos.ai/research/2026-07-17-turn-taking-barge-in-realtime-voice-agents/)
- LiveKit adaptive interruption handling "classifies overlapping speech as true barge-in versus backchannel ('mm-hmm'), cough, or ambient noise, and can resume speech after a false interruption" — [Zylos Research](https://zylos.ai/research/2026-07-17-turn-taking-barge-in-realtime-voice-agents/); product page [LiveKit Voice Agents](https://livekit.com/voice-agents)

**Why plain VAD is insufficient**
- "Pure VAD treats backchanneling (the 'uh-huh / mhm' signals listeners emit to show engagement without taking the turn) as either silence or a full barge-in attempt"; the 2026 stack migrates to models that "classify backchannel vs. barge-in vs. continued silence as a learned signal instead of an energy threshold" — [Zylos Research](https://zylos.ai/research/2026-07-17-turn-taking-barge-in-realtime-voice-agents/)
- Named production implementations: "Pipecat's SmartTurnAnalyzer, LiveKit's TurnDetector, and Vapi's endpointing controls" — [Zylos Research](https://zylos.ai/research/2026-07-17-turn-taking-barge-in-realtime-voice-agents/)

**Barge-in mechanics**
- Barge-in requires four things: full-duplex audio (listening while speaking), **acoustic echo cancellation** so the agent doesn't hear itself, turn detection to separate real interruptions from backchannels, and "a fast cancellation path that tears down the in-flight speech and generation within a few audio frames" — [Cekura, Barge In: What It Is in Voice AI and How It Fails](https://www.cekura.ai/discover/barge-in); [Future AGI, Voice AI Barge-In and Turn-Taking: A 2026 Implementation Guide](https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/)
- On-device considerations for barge-in and interruption handling — [RunEdge, Barge-in and interruption handling for on-device voice agents](https://www.runedge.ai/blog/barge-in-interruption-handling-on-device-voice)
- Testing full-duplex agents is itself a new discipline post-GPT-Live — [Roark, Testing full-duplex voice agents after GPT-Live](https://roark.ai/blog/testing-full-duplex-voice-agents-gpt-live)

**ASR-integrated turn detection (removes a serial stage)**
- Deepgram Flux: vendor-claimed **median end-of-turn under 300 ms, p95 1.5 s**, saving **200–600 ms** versus STT+VAD — [Deepgram Flux announcement](https://deepgram.com/learn/introducing-flux-conversational-speech-recognition)
- AssemblyAI Universal-3.5 Pro Realtime: end-of-turn detection "reads tonality, pacing, and rhythm and lands around 300 ms," with three tunable modes — [ChatGate](https://chatgate.ai/post/assemblyai-universal-3-pro-streaming)

**Academic work**
- Hierarchical end-of-turn modelling with primary-speaker segmentation for real-time conversational AI — [arXiv:2603.13379](https://arxiv.org/pdf/2603.13379)
- FireRedChat, a pluggable full-duplex voice interaction system with cascaded and semi-cascaded implementations — [arXiv:2509.06502](https://arxiv.org/html/2509.06502v1)
- Full-Duplex-Bench-v3 benchmarks tool use for full-duplex voice agents under real-world disfluency — [arXiv:2604.04847](https://arxiv.org/pdf/2604.04847)
- Idiosyncratic and dyad-level variation in human turn-taking timing, relevant to why a single global endpointing threshold fails — [arXiv:2505.24736](https://arxiv.org/pdf/2505.24736)

### Inferences
- The end-of-turn stage is additive to the budget in a cascade but *free* in a native S2S model (the model decides internally). That is a real architectural advantage for S2S that is independent of raw model speed — and it is also why cascade vendors are racing to fold turn detection into ASR.
- Smart Turn v3 at <60 ms CPU is cheap enough to run locally in every pipeline; the practical latency cost of good endpointing in 2026 is tens of milliseconds of *compute* plus whatever silence window the model chooses to wait, which is the real cost.
- A travel-advisor agent — where users think aloud mid-sentence ("we want to go to… uh… somewhere warm in, let's say, March") — is precisely the case where naive silence-threshold endpointing produces interruptions. Semantic endpointing is not optional for this use case.

### Gaps
- I could not fetch LiveKit's turn-detection docs, so I have no confirmed current parameter values (default `min_endpointing_delay` / `max_endpointing_delay`) or the current model size for LiveKit's multilingual turn detector.
- No published accuracy figures (precision/recall on turn boundaries) for Smart Turn v3 or LiveKit Turn Detector that I could verify — the HuggingFace card presumably has them but was unreachable.
- No measured figure for how long a barge-in cancellation path actually takes in Pipecat or LiveKit ("a few audio frames" is qualitative).

---

## Q6. How much latency users actually tolerate

### Takeaway
The often-quoted "200 ms" target traces to genuine conversation-analysis research (Stivers et al., PNAS 2009: cross-linguistic modal response offset of 0 ms, medians 0–+300 ms), but the operational thresholds circulating in voice-AI marketing (300 ms / 500 ms / 1.5 s) are mostly practitioner heuristics without published studies behind them. The strongest controlled HCI evidence I found suggests users prefer ~1.5 s latency agents and that engagement, perceived competence and willingness to re-engage all fall as latency rises.

### Cited Findings

**The human baseline (primary, peer-reviewed)**
- Stivers et al., across 10 typologically diverse languages: "all languages show a similar distribution of response offsets (unimodal peak of response within 200 ms of the end of the question)"; "the mode offset for each language between 0 and +200 ms, and an overall mode of 0 ms. The medians range from 0 ms (English, Japanese, Tzeltal, Yélî-Dnye) to +300 ms (Danish, ǂĀkhoe Haiǁom, Lao), overall cross-linguistic median +100 ms" — [Stivers et al., "Universals and cultural variation in turn-taking in conversation," PNAS 2009](https://www.pnas.org/doi/10.1073/pnas.0903616106) ([PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC2705608/), [PubMed 19553212](https://pubmed.ncbi.nlm.nih.gov/19553212/))
- Broader review of the cognitive machinery that makes ~200 ms gaps possible despite ~600 ms language-production planning time — [Levinson & Torreira / Levinson, "Turn-taking in Human Communication," Trends in Cognitive Sciences](https://www.sciencedirect.com/science/article/abs/pii/S1364661315002764); [Editorial: Turn-Taking in Human Communicative Interaction, Front. Psychol.](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4685262/); [Timing in Conversation, Journal of Cognition](https://journalofcognition.org/articles/10.5334/joc.268)

**Controlled study of LLM-agent response delay (the best direct evidence found)**
- "Higher response latency was associated with lower engagement, good impression, competence, and willingness to interact again, as well as increased discomfort. Most participants favored agents with low (1.5 s) latency, with **46.29% of participants directly mentioning fast response times as the main reason for preferring an agent, and 40.74% mentioning slow response times as the reason for disliking one**" — [Mitigating Response Delays in Free-Form Conversations with LLM-powered Intelligent Virtual Agents, arXiv:2507.22352](https://arxiv.org/pdf/2507.22352)

**Practitioner thresholds (heuristics, not studies — label them as such)**
- "When response delays extend beyond 300–400 ms, users perceive awkwardness. Beyond 500 ms, users begin to wonder if the agent heard them, and beyond 1 second, they assume something is wrong… beyond ~2000 ms, conversations start to fail" — [Parloa, Speech latency in voice AI for CX](https://www.parloa.com/knowledge-hub/speech-latency-voice-ai/); [Parloa, What Is Agentic AI Latency?](https://www.parloa.com/knowledge-hub/agentic-ai-latency/)
- "Under 300 ms feels human, 300–600 ms sluggish but acceptable, above 600 ms callers revert to touch-tone mental models, above 1.5 s they hang up" — [Forasoft LiveKit guide](https://www.forasoft.com/blog/article/livekit-ai-agents-guide)
- AssemblyAI's "300 ms rule" framing — [AssemblyAI, The 300ms rule: Why latency makes or breaks voice AI applications](https://www.assemblyai.com/blog/low-latency-voice-ai)
- Picovoice's treatment of voice UX latency and turn-taking — [Picovoice, Voice Agent Latency, Turn-Taking, and Barge-In](https://picovoice.ai/guide/voice-agents/voice-ux-latency-turn-taking/); SignalWire's on what "low latency" is actually measuring — [SignalWire](https://signalwire.com/blogs/industry/what-latency-means-voice-ai)

**Abandonment claim — treat with suspicion**
- "With 4,500 ms average latency, call abandonment reached 32%, while with 950 ms average latency, abandonment dropped to 8%" — [Master of Code, Why Voice AI Latency Is Costing You Customers](https://masterofcode.com/blog/voice-ai-latency). **No methodology, sample size, or industry context is given; this is an uncontrolled vendor-adjacent figure and should not be quoted as evidence.**

### Inferences
- The gap between the human baseline (0–300 ms) and what even the best 2026 systems achieve (600–1,200 ms voice-to-voice) means *no current voice agent is at human turn-taking speed*. What good systems do instead is manage the *perception* of delay — filler phrases, backchannels, early acknowledgement audio — rather than actually hit 200 ms.
- The arXiv:2507.22352 finding that users preferred a 1.5 s-latency agent (the low condition in that study) suggests the marginal UX return on grinding from 900 ms to 600 ms may be far smaller than the industry's obsession implies. The bigger UX variable is probably *consistency* (tail latency) and whether the agent interrupts, not median latency.
- Stivers's cross-linguistic medians (Danish, Lao at +300 ms; English, Japanese at 0 ms) imply latency tolerance is mildly language-dependent — potentially relevant for a Spanish-language travel advisor, though Spanish was not among the 10 languages in that study.

### Gaps
- I found **no published study** establishing the 300 ms / 500 ms / 800 ms thresholds that the voice-AI industry quotes. They appear to be back-derived from the Stivers turn-taking distribution plus practitioner experience. This should be stated plainly in any report.
- No study of latency tolerance specifically in *asynchronous voice-note* interaction (the reader's current mode), where expectations are almost certainly far looser — arguably the most important missing datum for this decision.

---

## Q7. Transport-level constraints: WebRTC vs SIP vs WebSockets

### Takeaway
WebRTC is the correct default for real-time voice because it is UDP-based, jitter-adaptive and loss-tolerant; WebSockets run over TCP and are structurally exposed to head-of-line blocking spikes of 100–300 ms on bad networks; SIP/PSTN adds mostly RTT plus transcoding but drags in real-world tail latency. For the reader specifically, WhatsApp voice notes have no real-time transport at all — the WhatsApp Business Calling API is the only path to a streaming agent on that channel, and its availability is still gated.

### Cited Findings

**WebRTC vs WebSocket**
- "WebRTC delivers audio and video at approximately 0.2 to 0.5 seconds glass-to-glass, while WebSocket delivers a text message in roughly one network round trip" — but these measure different quantities: a WebSocket RTT on a good network is tens of ms, while the WebRTC figure covers capture, encode, packetize, jitter-buffer, decode and render — [GetStream, WebRTC vs. WebSocket](https://getstream.io/blog/webrtc-websocket-av-sync/)
- "For WebRTC-native paths, on a clean network, the end-to-end path from microphone to AI server lands under 100 ms" — [LiveKit, Why WebRTC beats WebSockets for realtime voice AI](https://livekit.com/blog/why-webrtc-beats-websockets-for-voice-ai-agents) (vendor, and LiveKit sells WebRTC infrastructure)
- TCP head-of-line blocking: "one lost segment stalls everything queued behind it, and a tuned jitter buffer can experience a 300 ms spike"; WebSocket-on-TCP retransmits "can add 100+ ms spikes on bad networks," whereas WebRTC degrades gracefully with Opus FEC — [LiveKit](https://livekit.com/blog/why-webrtc-beats-websockets-for-voice-ai-agents); [Ant Media, WebRTC vs WebSocket](https://antmedia.io/webrtc-vs-websockets-what-are-the-differences/)
- A dissenting practitioner report that switched *back* from WebRTC to WebSockets for an audio pipeline — worth reading for the counter-case — [DEV, I Tested Our WebSocket Audio Pipeline with WebRTC. Here's Why I Switched It Back](https://dev.to/nick_lackman/i-tested-our-websocket-audio-pipeline-with-webrtc-heres-why-i-switched-it-back-3g1j)

**Jitter buffer and codec costs (the components of transport latency)**
- WebRTC's NetEQ "accelerates playback during unvoiced speech segments to reduce latency when buffers grow, and decelerates or inserts comfort noise when buffers run low"; one engineering report reduced jitter-buffer delay **from 40 ms to ~10 ms** — [Medium, The World's Fastest Voice Agent with AI, WebRTC, Whisper](https://medium.com/@BeingOttoman/the-worlds-fastest-voice-agent-with-ai-webrtc-whisper-and-latency-comparisons-fd4604ebe537); [DEV, The Fastest, Strongest AI Voice Dialogue Network Transmission Solution](https://dev.to/mpoiiii/the-fastest-strongest-and-best-ai-voice-dialogue-network-transmission-solution-4p4)
- "Opus encoding and decoding were each taking 30 ms" before optimisation — [Medium, World's Fastest Voice Agent](https://medium.com/@BeingOttoman/the-worlds-fastest-voice-agent-with-ai-webrtc-whisper-and-latency-comparisons-fd4604ebe537)

**SIP / PSTN**
- "Unless you intentionally configure your solution to introduce latency, the impact of SIP on overall latency is generally limited to RTT, plus a small allowance for jitter and audio transcoding" — [Relinns, WebRTC vs SIP for AI Voice Agents](https://relinns.com/blogs/webrtc-vs-sip-for-ai-voice-agents)
- Real-world counter-example: a reported **~325 ms one-way audio latency** on a Twilio→LiveKit SIP inbound trunk with both sides in US-Ashburn, attributed to the SIP-to-WebRTC bridging pipeline — [LiveKit Community forum thread](https://community.livekit.io/t/subject-325ms-one-way-audio-latency-in-sip-inbound-trunk-need-internal-pipeline-diagnostics/270)
- "WebRTC saves 150–700 ms compared to PSTN phone calls, leaving 240–270 ms for STT + LLM + TTS, whereas with a phone call, you might have 0–100 ms left after transport eats the budget" — [Chanl, Voice AI pipeline: STT, LLM, TTS and the 300 ms budget](https://www.channel.tel/blog/voice-ai-pipeline-stt-tts-latency-budget)
- OpenAI Realtime specifically offers both WebSocket and WebRTC connection modes with different trade-offs — [CallSphere, OpenAI Realtime: WebSocket vs WebRTC Tradeoffs in 2026](https://callsphere.ai/blog/vw1c-openai-realtime-websocket-vs-webrtc-tradeoffs-2026); [OpenAI Developers, Developer notes on the Realtime API](https://developers.openai.com/blog/realtime-api)
- Gemini Live API runs over **WebSocket** — [Google AI, Live API capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

**WhatsApp as a channel (directly relevant to the reader)**
- Meta launched the **WhatsApp Business Calling API** on 15 July 2025, bringing VoIP calls into WhatsApp Business chats — [Hyperleap, WhatsApp Business Calling API: What It Is and Where It's Headed (2026)](https://hyperleap.ai/whatsapp-business-api/calling-api)
- A WhatsApp AI voice agent = WhatsApp Business Calling API + a real-time STT/LLM/TTS pipeline — [Devotel Orbit, WhatsApp AI Voice Agents in 2026](https://orbit.devotel.io/en/resources/whatsapp-ai-voice-agents); [ChakraHQ, WhatsApp AI Voicebot](https://chakrahq.com/article/whatsapp-ai-voicebot-calling-api/)
- Access status as of 2026: "Select businesses with established Meta partnerships and sufficient scale can access calling functionality directly through the Cloud API," with larger BSPs having integrated it via early-access/beta; "the component pieces… exist. The integration is what is still maturing" — [Hyperleap](https://hyperleap.ai/whatsapp-business-api/calling-api)

### Inferences
- The reader's migration question has a hidden precondition: there is no streaming path over WhatsApp *messaging*. Either they (a) keep the async voice-note cascade and optimise it, (b) get access to the WhatsApp Business Calling API and build a real-time agent on top of it (SIP/VoIP-like budget, so the tighter 240–270 ms compute budget applies), or (c) move the real-time experience to a web/app WebRTC surface and keep WhatsApp for async. These are very different projects.
- If the reader does go to WhatsApp calling, the transport budget resembles telephony more than WebRTC-to-browser, which means the sub-500 ms targets in vendor marketing are not reachable and an 800 ms–1.2 s P95 SLO is the realistic target.
- The 325 ms SIP bridging report shows that transport overhead in practice is often an *implementation* problem (bridging, transcoding, buffer tuning) rather than a physics problem.

### Gaps
- No published latency figures specific to the WhatsApp Business Calling API media path (codec, jitter characteristics, one-way delay). This is the single most important unknown for the reader's decision and I found nothing quantitative.
- No independent measurement comparing OpenAI Realtime over WebRTC vs over WebSocket.

---

## Q8. Quality trade-offs: native speech-to-speech vs cascade

### Takeaway
Native S2S buys latency, prosody and natural interruption at the cost of measurable reasoning degradation ("intelligence degradation" is now a named, benchmarked phenomenon), opaque failure modes, fewer vendors, weaker structured-output guarantees, and cost that scales with conversation length. The cascade buys text at every boundary — logs, moderation hooks, swappable components, deterministic tool contracts — and is the documented enterprise default. The 2026 generation of S2S models (async tool calling, background thinking) has narrowed but not closed the tool-use gap.

### Cited Findings

**Reasoning degradation in S2S**
- "End-to-end speech large language models often lead to a decline in reasoning and generation performance compared to text input, a phenomenon referred to as **intelligence degradation**"; S2SBench quantifies it via a pairwise perplexity protocol on sentence continuation and commonsense reasoning under audio input — [S2SBench, arXiv:2505.14438](https://arxiv.org/abs/2505.14438)
- **Big Bench Audio**: 1,000 audio questions adapted from Big Bench Hard across four categories (Formal Fallacies, Navigate, Object Counting, Web of Lies, 250 each). Critically: "**traditional pipeline approaches (Whisper → GPT-4o → TTS-1) show minimal performance degradation compared to pure text processing**" — i.e. the cascade *preserves* reasoning, which is the core quality argument for it — [Artificial Analysis / HuggingFace, Evaluating Audio Reasoning with Big Bench Audio](https://huggingface.co/blog/big-bench-audio-release)
- Instruction-following specifically in audio LLMs — [IFEval-Audio, arXiv:2505.16774](https://arxiv.org/pdf/2505.16774)
- Conversational-agent evaluation for audio-grounded LLMs — [VCB-Bench, arXiv:2510.11098](https://arxiv.org/html/2510.11098v2)
- **Caveat on currency:** S2SBench and Big Bench Audio's pipeline comparison predate the 2026 generation. Gemini 3.8 Live Extended Thinking now scores **97.7% on Big Bench Audio** — [MarkTechPost](https://www.marktechpost.com/2026/09/15/google-releases-gemini-3-8-live-and-3-8-live-extended-thinking-for-production-grade-voice-agents/) — which suggests the reasoning gap has largely closed at the frontier, even if it persists in smaller/open S2S models.

**Tool use**
- Artificial Analysis's agentic benchmark "measures multi-turn instruction following, the ability to support a simulated customer through a complete interaction, and successful tool use against simulated customer service systems" — [Artificial Analysis speech-to-speech methodology](https://artificialanalysis.ai/methodology/speech-to-speech-benchmarking)
- Sierra's τ-Voice: Gemini 3.8 Live Extended Thinking **68.6%**, previous generation **37.7%**, τ-Voice-banking **35.1%** — so even the best S2S model fails roughly a third of general multi-step voiced tool tasks and two-thirds of banking-domain ones — [MarkTechPost](https://www.marktechpost.com/2026/09/15/google-releases-gemini-3-8-live-and-3-8-live-extended-thinking-for-production-grade-voice-agents/)
- OpenAI gpt-realtime-2.1 supports function calling but **not structured outputs**; guidance is to "use a chained path when a strict structured intermediate contract is required" and to validate tool arguments in application code — [benchr.org review](https://benchr.org/articles/gpt-realtime-2-1-review); [OpenAI API docs](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- Full-Duplex-Bench-v3 specifically benchmarks tool use for full-duplex agents under real-world disfluency — [arXiv:2604.04847](https://arxiv.org/pdf/2604.04847)

**Transcripts, auditability, compliance**
- "Cascaded architecture is recommended for anything needing auditability, compliance, provider flexibility, deep tool use, and predictable cost, because text at every boundary gives you logs, swappable components, and moderation hooks; it is the enterprise default." Conversely S2S requires "accepting opaque failures, fewer vendors, and token cost that grows with call length" — [Gradium 2026 architecture comparison](https://gradium.ai/content/cascaded-voice-agent-vs-speech-to-speech-2026)
- On compliance: "HIPAA's audit controls standard requires mechanisms that record and examine activity in systems containing electronic protected health information. The regulation doesn't specify text transcripts by name. In practice, compliance teams treat transcripts as required audit artifacts" — [Gradium](https://gradium.ai/content/cascaded-voice-agent-vs-speech-to-speech-2026)
- S2S models do emit transcripts as a side channel (OpenAI Realtime and Gemini Live both expose input/output transcription), but these are model-generated reconstructions rather than the ground truth the model actually conditioned on — [Microsoft Q&A, Realtime API token limit + user audio transcription](https://learn.microsoft.com/en-us/answers/questions/5510917/realtime-api-token-limit-(context-window)-user-aud); [OpenAI Developers, Realtime API notes](https://developers.openai.com/blog/realtime-api)

**Cost per minute, head to head**
- "In production, a cascaded voice stack runs about **$0.13/minute**, native realtime uncached runs about **$0.32/minute**, and the same realtime call with caching and trimmed tool schemas runs about **$0.075/minute**" — [Auto Interview AI, Voice AI Pricing in 2026: Cascade vs Voice-to-Voice](https://www.autointerviewai.com/blog/voice-ai-pricing-cost-per-minute-2026)
- A much cheaper cascade is possible with a single vendor's own components: Inworld Realtime STT + self-served Gemma 4 26B + Inworld Realtime TTS-2 at **~$0.007/min** on a committed tier, vs **~$0.091/min** for OpenAI's flagship S2S model — [Inworld, Voice Agent Cost Per Minute 2026](https://inworld.ai/resources/voice-agent-cost-per-minute-2026) (vendor's own comparison, favourable to itself)
- Component pricing to build your own model: Deepgram Nova-3 $0.0048/min + Flux $0.0065/min ([Deepgram pricing](https://deepgram.com/pricing)); Gemini 3.8 Live $0.005/min in, $0.018/min out ([Pasquale Pillitteri](https://pasqualepillitteri.it/en/news/16547/gemini-3-8-live-audio-model)); Nova 2 Sonic ~$0.015/min ([llm-stats](https://llm-stats.com/models/nova-2-sonic))
- The structural cost asymmetry: "talking to AI costs ~10× more than typing" because audio tokens are dense and the full audio history stays in context — [Nadir, The Voice Tax](https://getnadir.com/blog/voice-ai-agent-real-time-cost-tax/)
- A public calculator for modelling the trade-off — [Softcery, Free AI Voice Agent Cost & Latency Calculator 2026](https://softcery.com/ai-voice-agents-calculator)

**Where S2S wins**
- S2S is preferred "when conversational naturalness and the lowest interruption latency matter most" — [Gradium](https://gradium.ai/content/cascaded-voice-agent-vs-speech-to-speech-2026)
- S2S preserves paralinguistics (tone, emotion, hesitation, accent) that a transcript destroys — this is the one capability a cascade structurally cannot recover — [Inworld, Cascaded vs Speech-to-Speech Voice Architecture](https://inworld.ai/resources/cascaded-vs-speech-to-speech-voice-architecture); [Deepgram, Speech-to-Speech Models for Enterprise](https://deepgram.com/learn/speech-to-speech-models-enterprise-explained)

### Inferences
- The strongest argument against native S2S for a *travel advisor* is not latency or quality — it is that travel advice is tool-heavy and record-keeping-heavy (bookings, prices, itineraries, confirmations). τ-Voice-banking at 35.1% for the best model is a direct warning about voiced multi-step transactional tasks.
- The cost picture inverts the usual intuition: a well-priced cascade ($0.007–$0.13/min depending on vendor choice) is generally *cheaper* than native S2S ($0.075–$0.32/min), because S2S charges for the whole conversation's audio context on every turn. Prompt caching is what makes S2S competitive, and it is fragile.
- A defensible middle path that appears in several sources: keep the cascade's text boundaries for tool-calling and logging, but adopt the streaming machinery (streaming ASR with integrated turn detection, streaming LLM, streaming TTS, Smart Turn/LiveKit turn detector, WebRTC transport). This captures most of the latency win without giving up auditability — and it is a strictly smaller change than moving to S2S.
- For the reader's specific migration: the fact that their current interaction is async voice notes means they have *never* paid the turn-taking engineering cost. That cost (VAD tuning, endpointing, barge-in, echo cancellation, interruption teardown) is the real work of moving to a streaming agent, and it is mostly architecture-independent — it does not go away by choosing S2S, it just moves inside the vendor's model.

### Gaps
- No public per-model measurement of transcript fidelity for S2S models (how accurate the exposed transcript is relative to what the model actually heard) — a material auditability question with no data.
- No data on S2S quality specifically for **Spanish or multilingual travel-domain conversation**; all the benchmarks cited (Big Bench Audio, τ-Voice, S2SBench) are English-centric.
- The cost figures come from different sources with different assumptions (turn lengths, caching, committed tiers). They are not apples-to-apples and should be re-derived from vendor pricing pages for the reader's actual call profile.
- I could not verify any of the vendor pricing pages directly (all blocked), so every price above is second-hand as of the cited page's publication date.

---

## Cross-cutting methodological warnings for the report writer

1. **Vendor vs independent.** Every TTS TTFB figure has a vendor number and an independent number roughly 3–5× apart. Always state which. Coval's page title ("Why Vendor Benchmarks Lie") is itself the most quotable framing of this — [Coval](https://www.coval.ai/blog/best-text-to-speech-providers-in-2026-how-to-choose-(and-why-vendor-benchmarks-lie)/).
2. **Superseded models.** GPT-4o Realtime, Gemini 2.5/3.1 Flash Live, Deepgram Nova-2, ElevenLabs Turbo v2.5 and PlayHT all appear in comparisons circulating in 2026 but are historical. PlayHT/PlayAI is reported as being wound down by Meta.
3. **Unverifiable primary sources.** Every fetch to a vendor, arXiv, HuggingFace or docs domain was blocked in this environment. A follow-up pass with working network access should re-verify, at minimum: the Pipecat benchmarks page, the LiveKit latency post, Google's Gemini Live pricing, OpenAI's realtime model page, and Coval's and Artificial Analysis's leaderboard tables.
4. **Benchmark non-comparability.** WER on general streaming corpora, WER on agent-speech corpora, turn-detection latency, TTFA and voice-to-voice latency are five different metrics that get mixed in most comparison articles.
