# AI Research Agent Architecture: Evidence-Based Design Choices (2025-2026)

> **Sourcing caveat for the report writer:** In this session the egress proxy blocked direct WebFetch to `anthropic.com`, `arxiv.org`, `alphaxiv.org`, `zenml.io`, `simonwillison.net`, and `emergentmind.com`. Every finding below therefore comes from search-engine result summaries that quote and link the primary source. The primary URLs are cited so the writer can verify. Where a number appears only in a secondary/blog restatement of a primary source, I say so explicitly. Treat any figure marked "secondary restatement" as needing a confirming click-through before it goes in a final report.

---

## Q1: How are the leading deep-research systems built? (orchestrator/subagent split and what the authors said mattered)

### Takeaway
The field has split into two credible shapes: Anthropic's **orchestrator-worker multi-agent** system (lead agent on a frontier model, parallel subagents on a cheaper tier) and OpenAI's / Google's **single agent trained end-to-end with RL** on browsing. Anthropic reports a 90.2% relative win for multi-agent over single-agent on their internal research eval; OpenAI and Google both argue the intelligence should live in one RL-trained orchestrating policy rather than in a hand-built agent graph. Open-source systems (GPT Researcher, STORM) converge on planner→parallel-executors→publisher with explicit source-count floors.

### Cited Findings

**Anthropic (multi-agent, orchestrator-worker) — June 2025**
- Architecture is an orchestrator-worker pattern: a lead agent coordinates specialized subagents that search and filter in parallel — [Anthropic, "How we built our multi-agent research system", via ZenML LLMOps DB](https://www.zenml.io/llmops-database/building-a-multi-agent-research-system-for-complex-information-tasks)
- Internal eval: multi-agent Claude Opus 4 lead + Claude Sonnet 4 subagents **outperformed single-agent Claude Opus 4 by 90.2%** on research tasks — [ZenML LLMOps DB summary of Anthropic post](https://www.zenml.io/llmops-database/building-production-multi-agent-research-systems-with-claude)
- The lead agent plans, then **spins up 3-5 specialized subagents in parallel**, each given a self-contained task spec: an objective, an output format, a tool list, and an explicit stop condition — [ZenML LLMOps DB / Anthropic](https://www.zenml.io/llmops-database/building-production-multi-agent-research-systems-with-claude)
- Parallelism operates at two levels — lead spawns 3-5 subagents simultaneously, and each subagent issues multiple tool calls in parallel — **reducing research time by up to 90%** for complex queries — [The AI Engineer, restating Anthropic's post](https://theaiengineer.substack.com/p/how-anthropic-built-multi-agent-deep) (secondary restatement)
- Where multi-agent wins: **breadth-first queries with multiple independent directions**. Anthropic's worked example is "identify all board members of the IT companies in the S&P 500" — the multi-agent system decomposed it successfully, the single-agent system failed — [ZenML LLMOps DB / Anthropic](https://www.zenml.io/llmops-database/building-a-multi-agent-research-system-for-complex-information-tasks)
- Cost: the architecture consumes roughly **15x more tokens than standard chat**, so Anthropic's stated decision rule is that multi-agent pays off only when task value exceeds token cost — [ZenML LLMOps DB / Anthropic](https://www.zenml.io/llmops-database/building-production-multi-agent-research-systems-with-claude)
- Anthropic's context-engineering follow-up describes the subagent contract precisely: each subagent may burn **tens of thousands of tokens internally but returns only a condensed summary of ~1,000-2,000 tokens** to the lead agent — [Anthropic, "Effective context engineering for AI agents"](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**OpenAI Deep Research (single agent, end-to-end RL) — Feb 2025**
- Powered by an early version of o3 optimized for web browsing; trained with **end-to-end reinforcement learning on hard browsing and reasoning tasks**, learning searching, clicking, scrolling, file interpretation, and Python-in-sandbox as learned behaviors rather than hand-coded steps — [OpenAI, Introducing deep research](https://openai.com/index/introducing-deep-research/); [Deep Research System Card](https://cdn.openai.com/deep-research-system-card.pdf)
- Architecturally it emphasizes **unified reasoning and end-to-end control: core reasoning in a single orchestrating agent** that manages global state and memory, with browsing, RAG, citation tracking and document processing as intrinsic modules — [Emergent Mind, OpenAI Deep Research](https://www.emergentmind.com/topics/openai-deep-research)
- Training data mixes **objective auto-gradable tasks with ground truth** and **open-ended tasks scored against rubrics**, graded by a chain-of-thought grader model — [OpenAI Deep Research System Card](https://cdn.openai.com/deep-research-system-card.pdf)
- Reported scores: **51.5% BrowseComp, 42.9% BrowseComp-ZH, 26.6% HLE** — [Steel.dev BrowseComp leaderboard](https://leaderboard.steel.dev/leaderboards/browsecomp/)

**Google Gemini Deep Research (single agent + async task manager) — Dec 2024 onward**
- Originally built on Gemini 2.0 Flash Thinking; a **single-agent architecture** whose planning and adaptive research ability comes from RL-driven fine-tuning rather than an agent graph — [Deep Research Agents: A Systematic Examination and Roadmap](https://arxiv.org/pdf/2506.18096)
- Distinctive components: (a) **interactive research planning** — the agent emits a multi-step plan the user can review and edit before execution; (b) **asynchronous task management** with a shared state between the planner model and the task models, enabling **graceful error recovery without restarting the whole task**; (c) large-context RAG ensembles for synthesis — [Deep Research Agents survey](https://arxiv.org/pdf/2506.18096); [Gemini Deep Research overview](https://gemini.google/overview/deep-research/)

**Open source**
- **GPT Researcher**: planner-executor-publisher. Planner generates the research sub-questions; execution agents crawl **20+ web sources in parallel** with JS-enabled scraping; publisher aggregates into a 2,000+ word report with inline citations. Reported cost/latency: **~2 minutes and ~$0.005 per research task** — [GPT Researcher repo](https://github.com/assafelovic/gpt-researcher); [Tavily docs](https://docs.tavily.com/examples/open-sources/gpt-researcher)
- **STORM (Stanford)**: "Synthesis of Topic Outlines through Retrieval and Multi-perspective Question asking." Its thesis is that the hard part of research automation is **generating good questions**, and that directly prompting an LLM to ask questions does not work. STORM instead discovers **distinct perspectives** by surveying existing articles on similar topics, then simulates conversations between perspective-holding writers and a retrieval-grounded expert — [STORM paper](https://arxiv.org/pdf/2402.14207); [Stanford STORM project](https://storm-project.stanford.edu/research/storm/)
- STORM's measured gains: articles judged **better organized by a 25-percentage-point margin** and **broader in coverage by 10 points** versus outline-driven RAG baselines; the full pipeline produces the highest-recall outlines, and **reading retrieved information before asking questions is what makes the questions good** — [STORM paper](https://arxiv.org/pdf/2402.14207)

### Inferences
- The two shapes are not actually in conflict: OpenAI/Google put the orchestration policy *inside* the weights via RL; Anthropic puts it *outside* in a prompt-and-harness because they are composing off-the-shelf models. A venture studio building on API models has no RL lever, so the Anthropic shape is the only one available — which makes its published numbers the most transferable evidence.
- STORM's finding (perspective-diversification before question generation, and grounding questions in already-retrieved text) is the strongest published argument that a recursive orchestrator should spend real effort on *question decomposition quality*, not just on parallel fan-out. Naive decomposition is the failure mode STORM explicitly names.
- The ~1,000-2,000 token subagent return budget is the single most concrete interface spec published for an orchestrator-with-subagents system and is directly checkable against the reader's own design.

### Gaps
- Anthropic has not published absolute benchmark scores (BrowseComp/GAIA/DRB) for the multi-agent research system, only the internal-eval relative delta. The "90.2%" is therefore not comparable to public leaderboard numbers.
- I could not verify whether the Gemini Deep Research production system (2026 "Deep Research Max" API tier) still uses the single-agent shape described in the mid-2025 survey.

---

## Q2: What does the evidence say about search budget?

### Takeaway
Anthropic's variance decomposition is the headline: **token usage alone explains ~80% of performance variance**, tool-call count ~10%, model choice ~5% — together ~95%. Independent 2025-2026 work confirms accuracy rises monotonically with tool-call budget on BrowseComp up to a point, then degrades if budget is force-extended. The concrete Anthropic heuristic is 3-10 tool calls for simple fact-finding, 10-15 per subagent for comparisons, 10+ subagents for complex research.

### Cited Findings
- **Three factors explain ~95% of performance variance in Anthropic's browsing evals: token usage 80%, number of tool calls ~10%, model choice ~5%** — [ZenML LLMOps DB restating Anthropic's post](https://www.zenml.io/llmops-database/building-production-multi-agent-research-systems-with-claude); also restated in [Codingscape summary](https://x.com/codingscape/status/1937503477971697684) (secondary restatements of [Anthropic's engineering post](https://www.anthropic.com/engineering/multi-agent-research-system), which I could not fetch directly)
- Anthropic's published scaling heuristic, embedded in the lead agent's prompt: **simple fact-finding = 1 agent, 3-10 tool calls; direct comparison = 2-4 subagents, 10-15 calls each; complex research = 10+ subagents with clearly divided responsibilities** — [ZenML LLMOps DB / Anthropic](https://www.zenml.io/llmops-database/building-a-multi-agent-research-system-for-complex-information-tasks)
- Anthropic's stated reason for the multi-agent shape is essentially a token-budget argument: subagents give **parallel token capacity with separate context windows**, so the system can spend more total tokens on a task than one context window allows — [Anthropic, Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Increasing the **maximum tool-call budget improves BrowseComp performance steadily**; and once the tool-call limit reaches **16 or more**, RL-trained models clearly separate from SFT-only counterparts (i.e., budget headroom is what lets a better policy show its advantage) — [DeepDive: Advancing Deep Search Agents with Knowledge Graphs and Multi-Turn RL](https://arxiv.org/pdf/2509.10446)
- Test-time scaling for deep search has two axes — **sequential** (longer trajectories, more tool calls in one run) and **parallel** (multiple candidate solutions, then verify/select). Some systems maintain **log-linear scaling through 64 parallel searchers**, but **excessive budget forcing eventually degrades performance** — [Pushing Test-Time Scaling Limits of Deep Search with Asymmetric Verification](https://arxiv.org/pdf/2510.06135)
- A "Test-Time Scaling law for Agentic Deep Research" is claimed, with normalized performance improving roughly **linearly in both internal reasoning depth and external knowledge exploration** — [From Web Search towards Agentic Deep Research](https://arxiv.org/pdf/2506.18959)
- Latency/cost anchor for a *thin* budget: GPT Researcher's 20+ sources in ~2 minutes for ~$0.005 — [GPT Researcher](https://github.com/assafelovic/gpt-researcher) — i.e., a 20-source floor is cheap enough to be a hard minimum, not a luxury.

### Inferences
- The 80/10/5 decomposition means **an under-budgeted research agent cannot be fixed by a better model**. If a studio's agents are doing 3-5 searches on a task Anthropic's own heuristic would assign 10+ subagents and 100+ total tool calls, the dominant term in the quality equation is being left on the table, and swapping Sonnet for Opus recovers only the ~5% model term.
- The published evidence supports a *floor* much more strongly than an optimum. Everyone agrees more search helps up to a limit; nobody has published the inflection point for open-ended report writing (as opposed to needle-in-haystack BrowseComp tasks).
- Combining Anthropic's heuristic with the 1-2k-token return budget gives a checkable spec: a "complex research" task should show on the order of 10 subagents x 10-15 tool calls = 100-150 retrievals, and roughly 10-20k tokens of condensed evidence arriving at the orchestrator.

### Gaps
- **No published number for "how many searches a research report actually needs"** in the open-ended, narrative-report sense. All quantified budget curves I found are on short-answer agentic benchmarks (BrowseComp, GAIA), where the target is a single verifiable fact.
- I found no study that measures the *quality penalty of too few searches* directly (e.g., report quality at 5 vs 25 vs 100 retrievals). The closest proxies are the monotone tool-budget curves above and the citation-accuracy work in Q5.
- Anthropic's exact variance figures could not be read off the primary post due to the egress block; they are consistent across at least three independent secondary restatements, but should be click-verified.

---

## Q3: Model-tier choice per role — is a cheap small model sound for a critic/verifier or a quantitative analyst?

### Takeaway
**For verification and citation-checking: yes, this is well supported.** A July 2026 benchmark found GPT-5-mini achieved the best source-relevance F1 (0.908) of eight judges tested, and rubric-verification work finds the open-weight/proprietary gap "relatively small." **For quantitative/numeric analysis: no.** Small models show a persistent fluency-vs-numeric-reliability gap and degrade sharply as numeric complexity rises. The asymmetry is the key: verification is a cheaper cognitive task than generation; arithmetic is not.

### Cited Findings

**Small models as verifiers/judges — supportive evidence**
- "Do You Need a Frontier Model as a Citation Verifier?" (July 2026) evaluated **8 off-the-shelf LLM judges across 3 model families against gold labels over 1,248 rubric decisions**, with 378 hard cases adjudicated from judge disagreements, on a Deep-Research Citation Benchmark spanning **25 topic domains**. Finding: **cheaper judges remain competitive; GPT-5-mini attained the strongest source-relevance pass-class F1 at 0.908** — [arXiv 2607.08700](https://arxiv.org/abs/2607.08700)
- "Can LLM-as-a-Judge Reliably Verify Rubrics in Agentic Scenarios?" finds **open-weight models are close to proprietary models** and that "strong open-weight models can already support high-quality rubric verification in many settings" — though frontier judges still lead on the hardest domains (Gemini-3.1 Pro Preview 94.7 on Deep Research rubrics; GPT-5.4 89.4 on Agentic Coding) and **all judges exhibit substantial noise, especially on agentic coding** — [arXiv 2606.29920](https://arxiv.org/pdf/2606.29920)
- A practitioner evaluation across the same 1,248-decision setup concludes **cheaper models are statistically competitive with frontier models on well-defined criteria, but differ substantially in failure modes that compound silently at scale**, and recommends: start with the smaller model, benchmark it against gold labels, only then decide — [Vector Labs, LLM-as-Judge cost vs quality](https://vector-labs.ai/insights/the-hidden-cost-of-using-frontier-models-as-your-ai-quality-judges)
- The theoretical backing is **asymmetric verification**: verification is cheaper than generation, so spending test-time compute on a verifier over many candidates scales better than spending it on a bigger generator — the basis for maintaining log-linear scaling through 64 parallel searchers — [arXiv 2510.06135](https://arxiv.org/pdf/2510.06135)
- Anthropic's own model-tier assignment is the canonical instance: **Opus 4 as lead/orchestrator, Sonnet 4 as subagents** — [ZenML LLMOps DB / Anthropic](https://www.zenml.io/llmops-database/building-production-multi-agent-research-systems-with-claude) — and model choice accounts for only ~5% of variance (Q2), i.e., tier-down of workers is cheap insurance.

**Small models on numbers — cautionary evidence**
- Small-to-medium open-weight and "mini" API models show **limited reasoning capability**: a 360M-parameter model reaches **36% on arithmetic evaluation and 12% on logical next-step tasks**; Qwen-0.5B reaches **78% and 48%** respectively — still short of reliable math proficiency — [EasyMath: A 0-shot Math Benchmark for SLMs](https://arxiv.org/pdf/2505.14852)
- A persistent gap exists between linguistic fluency and numerical reliability: **smaller models follow correct reasoning steps but make arithmetic errors in intermediate or final calculations**, and exhibit **representation fragility** — small perturbations in number format or phrasing change the outcome — [Exposing Numeracy Gaps](https://arxiv.org/pdf/2502.11075); [Mathematical Computation and Reasoning Errors by LLMs](https://arxiv.org/html/2508.09932v2)
- **Logical error rates rise by up to 14 percentage points as numerical complexity increases**, showing general weakness on out-of-distribution numeric values — [Mathematical Reasoning in LLMs: Assessing Logical and Arithmetic Errors across Wide Numerical Ranges](https://arxiv.org/abs/2502.08680)
- Real-world calculation accuracy is separately benchmarked (ORCA) precisely because benchmark math success does not transfer to applied calculation — [The ORCA Benchmark](https://arxiv.org/pdf/2511.02589)

### Inferences
- **The "cheap critic" is defensible; the "cheap quant" is not.** The verifier's job — "does this cited page support this sentence?" — is a bounded entailment judgment with a clear rubric, exactly the regime where the 2026 benchmarks say small models match frontier ones. A quantitative analyst's job — multi-step arithmetic over messy extracted figures — sits exactly in the regime where small models are documented to be fluent-but-wrong.
- Mitigation that the evidence supports: if a small model must do the quantitative role, force it to **emit code/tool calls for every calculation** rather than doing arithmetic in tokens. The documented failure is arithmetic-in-weights, not the surrounding reasoning ("smaller models generally follow appropriate reasoning steps but make minor arithmetic errors").
- The "failure modes that compound silently at scale" warning is the real risk for a small critic in a recursive system: a cheap judge whose errors are *correlated* (e.g., systematically passes plausible-sounding unsupported claims) will not be caught by more of the same judge. That argues for gold-label spot-checks of the critic itself, not for a bigger critic.

### Gaps
- No published study I found benchmarks a small model specifically in the role of **adversarial critic of a research report** (as opposed to rubric-grader or citation-checker). The transfer from citation verification to open-ended critique is an inference, not a measured result.
- No number found on how much quality is lost by tiering the *orchestrator* down — Anthropic's ~5% model-choice variance figure is aggregate over the system, not attributed to the lead-agent slot specifically.

---

## Q4: What verification patterns are documented, and which actually reduce error?

### Takeaway
The measured ranking is roughly: **self-consistency (cheap, +10-18 pts on reasoning) > chain-of-verification (large precision gains on list/factual tasks) > structured rubric-based LLM-judge with retrieval grounding > multi-agent debate (repeatedly fails to beat self-consistency at 2-3x the token cost)**. LLM-as-judge is usable but carries reproducible position, verbosity and self-preference biases large enough to swamp real quality differences.

### Cited Findings

**Self-consistency (2022 paper — clearly dated, still the baseline to beat)**
- Self-consistency (sample N reasoning chains, take the majority answer) gives **+17.9% absolute on GSM8K** with PaLM-540B/GPT-3 — [Self-Consistency Improves Chain of Thought Reasoning in Language Models, 2022](https://arxiv.org/pdf/2203.11171)
- Typical reported range across hard reasoning benchmarks is **+10 to +20 percentage points** — [zeroentropy, self-consistency](https://zeroentropy.dev/concepts/self-consistency/)

**Chain-of-Verification (CoVe) (2023 paper, ACL Findings 2024 — dated)**
- Mechanism: draft answer → plan verification questions → **answer each verification question independently so it is not biased by the draft** → regenerate the final response — [CoVe, arXiv 2309.11495](https://arxiv.org/abs/2309.11495)
- Wikidata list task: **precision more than doubles, 0.17 → 0.36** over the Llama-65B few-shot baseline; **hallucinated answers drop 2.95 → 0.68 per response** with only a small reduction in correct facts — [CoVe](https://arxiv.org/pdf/2309.11495)
- For longform generation the best variant is **"Factor + Revise"**: the model independently identifies which facts are consistent with the executed verifications, discards inconsistent facts, and regenerates from the consistent set — [CoVe / ACL Findings 2024](https://aclanthology.org/2024.findings-acl.212/)
- The **independence of verification answers from the draft is load-bearing** — this is the part most naive "ask the model to check its work" implementations drop — [CoVe](https://arxiv.org/pdf/2309.11495)

**Multi-agent debate — negative evidence**
- Multi-agent debate **significantly underperforms simple self-consistency majority voting** when compared at an equal number of sampled responses (GSM8K) — [When and Why Does Multi-Agent Debate Fail and Does It Really Underperform?](https://arxiv.org/html/2510.20963)
- Unguided homogeneous debate **fails to significantly outperform isolated self-correction once token cost is counted**; debate consumes **2.1-3.4x more tokens (up to 28,631 tokens per problem)** for equal or lower accuracy on 7-8B instruction-tuned models — [The Cost of Consensus, arXiv 2605.00914](https://arxiv.org/pdf/2605.00914)
- A position paper argues the field should **stop overvaluing multi-agent debate and instead embrace model heterogeneity** — i.e., debate's value, where it exists, comes from the agents being genuinely *different models*, not from the debate protocol — [arXiv 2502.08788](https://arxiv.org/abs/2502.08788)
- Foundational caution (2023, dated but not overturned): **LLMs cannot reliably self-correct reasoning without external feedback** — unguided self-critique often degrades correct answers — [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/pdf/2310.01798)

**LLM-as-judge and its biases**
- **Position bias: 10-15 points of win-rate swing** depending on slot order. **Verbosity bias: 15-30 points of inflated preference for longer outputs** across GPT-4, Claude and PaLM-2 judges. **Self-preference: ~10-25%**, with dataset-dependent spread from -38% to +90% on ArenaHard — [FutureAGI, LLM-Judge Bias Mitigation 2026](https://futureagi.com/blog/evaluating-llm-judge-bias-mitigation-2026/), synthesizing [MT-Bench/Chatbot Arena](https://arxiv.org/pdf/2306.05685) and [Self-Preference Bias in LLM-as-a-Judge](https://arxiv.org/pdf/2410.21819)
- Anthropic's practical finding: a **single LLM judge call with a structured prompt emitting a 0.0-1.0 score plus a pass/fail grade proved more consistent than multiple specialized judges**, scored against a rubric covering **factual accuracy, citation accuracy, completeness, source quality, and tool efficiency** — [The AI Engineer / ByteByteGo restating Anthropic's post](https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent) (secondary restatement)
- Rubric verification in agentic settings remains noisy even for frontier judges, with agentic coding the worst domain — [arXiv 2606.29920](https://arxiv.org/pdf/2606.29920)

**Verification as a scaling axis (2026)**
- **Asymmetric verification**: because verifying is cheaper than generating, allocating test-time compute to a verifier over many parallel candidates scales better; this maintains log-linear gains through 64 parallel searchers, versus budget-forcing a single trajectory which eventually degrades — [arXiv 2510.06135](https://arxiv.org/pdf/2510.06135)
- **Inference-time scaling of verification**: self-evolving deep research agents using **test-time rubric-guided verification** — the agent generates rubrics for its own output and iterates against them — [arXiv 2601.15808](https://arxiv.org/abs/2601.15808)
- **Verification-centric design** is now an explicit architecture class for efficient deep research agents — [Marco DeepResearch: Unlocking Efficient Deep Research Agents via Verification-Centric Design](https://arxiv.org/pdf/2603.28376)
- Multi-agent frameworks specifically for **citation hallucination detection** exist as a documented pattern — [Source or It Didn't Happen: A Multi-Agent Framework for Citation Hallucination Detection](https://arxiv.org/pdf/2605.08583)

### Inferences
- For a recursive orchestrator system, the highest-yield verification investment is **CoVe-style independent re-checking of extracted claims** (verification questions answered *without* the draft in context) plus **retrieval-grounded citation checking**, not a debate club. The debate literature is consistently negative on cost-adjusted grounds.
- If debate is used at all, the evidence says it must be **heterogeneous** (different model families) to add anything over cheaper sampling.
- The judge biases are large enough that an internal "critic scores the report 8/10" signal is close to meaningless unless the rubric is binary, per-claim, and retrieval-grounded — which is exactly what the 2026 citation-verification benchmarks operationalize. Score-the-whole-report judging is the bias-maximal setup (verbosity bias directly rewards the "confident long synthesis" failure mode).
- Anthropic's "one structured judge beats a committee of specialized judges" is worth flagging as counterintuitive and directly contrary to a natural instinct in recursive systems to add more critic roles.

### Gaps
- CoVe's headline numbers are from 2023 on Llama-65B. **I found no replication of CoVe magnitudes on 2025-2026 frontier models**, where baseline hallucination rates are far lower; the 2x precision gain should not be assumed to transfer.
- No head-to-head study found that ranks self-consistency vs CoVe vs retrieval-grounded citation checking *on the same long-form research-report task*. The ranking above is assembled across different tasks and eras.

---

## Q5: How do systems avoid "confident synthesis of thin evidence"?

### Takeaway
This is the best-measured failure mode in the 2026 literature and the numbers are bad: deep research agents produce citations that *look* fine — working links, topically relevant pages — while **the specific claim is actually unsupported 23-61% of the time** depending on the model. 3-13% of cited URLs are outright hallucinated. The documented countermeasures are per-claim retrieval-grounded fact-checking, source-quality heuristics in the prompt, independence-weighted triangulation, and calibrated abstention.

### Cited Findings

**The failure, quantified**
- "Cited but Not Verified" evaluates citations along three dimensions — **Link Works** (URL resolves), **Relevant Content** (topical alignment), **Fact Check** (claim actually supported by source content). Models reliably cite working, topically relevant sources, but **factual accuracy of cited claims ranges 39-77%** across systems — [arXiv 2605.06635](https://arxiv.org/abs/2605.06635)
- **Fact Check scores span 24% (OSS-120B) to 77% (Claude Opus 4.5) — a 53-point spread, making factual accuracy the most differentiating dimension** between systems, far more than link validity or relevance — [arXiv 2605.06635](https://arxiv.org/html/2605.06635v1)
- Plain statement of the user-facing implication: "a user encountering a citation in an LLM-generated report will almost always find a working link to a topically relevant page, yet the specific factual claims attributed to that source may be **unsupported nearly half the time**" — [arXiv 2605.06635](https://arxiv.org/html/2605.06635v1)
- **3-13% of citation URLs are hallucinated** (no record in the Wayback Machine, likely never existed); **5-18% are non-resolving overall**. Deep research agents generate substantially more citations per query than search-augmented LLMs **and hallucinate URLs at higher rates** — [Detecting and Correcting Reference Hallucinations in Commercial LLMs and Deep Research Agents](https://arxiv.org/html/2604.03173)
- Claim-level auditability is now a named research direction precisely because report-level fluency hides claim-level unsupportedness — [From Fluent to Verifiable: Claim-Level Auditability for Deep Research Agents](https://arxiv.org/html/2602.13855)

**Countermeasures with evidence**
- **Source-quality heuristics in the prompt**: Anthropic reports that agents defaulted to **SEO-optimized content farms over authoritative sources**, and that adding explicit source-quality heuristics to the prompt fixed it — [ZenML LLMOps DB / Anthropic](https://www.zenml.io/llmops-database/building-a-multi-agent-research-system-for-complex-information-tasks)
- **Citation accuracy is an explicit axis in Anthropic's judge rubric**, alongside factual accuracy, completeness, source quality and tool efficiency — [ByteByteGo restating Anthropic](https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent) (secondary restatement)
- **Independence-weighted triangulation**: a documented practice is to require corroboration from sources of *different origination types* (regulatory filings, verified media, direct observation) and to **score source independence** — using author overlap and shared institutional affiliation — so that highly overlapping sources are **down-weighted**, each source getting a High/Medium/Low independence rating that weights its contribution to a cross-source consensus score — [Altss, source triangulation taxonomy](https://altss.com/taxonomy/source-triangulation)
- **Calibrated abstention**: methods estimate confidence (including linguistic calibration) and abstain below a threshold; a survey of abstention in LLMs covers the design space — [Know Your Limits: A Survey of Abstention in LLMs, TACL](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00754/131566/Know-Your-Limits-A-Survey-of-Abstention-in-Large); [Mitigating LLM Hallucinations via Conformal Abstention](https://arxiv.org/pdf/2405.01563)
- **Abstention is trainable and can be dramatic**: in a code-optimization setting, guardrails raised **correct abstention from 0% to 44.4% while preserving a 100% edit rate on genuinely sub-optimal code with zero false abstentions** — [Efficiency Hallucination](https://arxiv.org/html/2609.14839). (Different domain — cited as a magnitude illustration, not a research-agent result.)
- **Why the failure persists structurally**: benchmarks typically *penalize* "I don't know," and RLHF amplifies the bias when human raters prefer long, detailed, confident answers over carefully hedged correct ones — hence the push for calibration-aware metrics that credit signaled uncertainty and treat refusal as a valid outcome — [Lakera, LLM Hallucinations in 2026](https://www.lakera.ai/blog/guide-to-hallucinations-in-large-language-models)
- **Progressive confidence estimation** in report generation is an active 2026 architecture — [Towards Trustworthy Report Generation: A Deep Research Agent with Progressive Confidence Estimation and Calibration](https://arxiv.org/pdf/2604.05952)
- **RL-trained abstention** with verifiable rewards plus post-refusal clarification — [Abstain-R1](https://arxiv.org/pdf/2604.17073)

### Inferences
- The 39-77% Fact Check range is the most actionable single statistic in this whole brief for a studio auditing its own system: it is directly measurable on your own outputs with the paper's three-dimension protocol, and it distinguishes "we have citations" from "our citations support our claims." A system that has never measured its own Fact Check rate should assume it is in the middle of that band.
- The combination of Q4's verbosity bias (judges reward longer answers by 15-30 points) and Q5's low Fact Check rates explains the failure mode mechanically: **an internal LLM judge scoring whole reports will actively reward confident synthesis of thin evidence.** The fix is per-claim binary verification against retrieved source text, which is also the task small models do well (Q3).
- Independence-weighted triangulation is documented as practice, not as a measured intervention. Treat it as a sound design principle with no published effect size.

### Gaps
- **No controlled study found that measures how much a triangulation requirement (N independent sources per claim) improves report accuracy.** The triangulation material is methodological/normative, largely from journalism and market-research practice, not from agent experiments.
- No published abstention result specific to deep research report writing — the 0%→44.4% figure is from code optimization and should not be presented as a research-agent number.

---

## Q6: Tool-use budgets and agent context design

### Takeaway
Tool-call count is an independent ~10% of performance variance in Anthropic's decomposition, on top of the ~80% from tokens — and the relationship with quality is monotone-then-degrading. Context design is the enabling constraint: the documented pattern is clean-context subagents returning heavily condensed summaries, plus compaction and structured note-taking for the orchestrator.

### Cited Findings
- **Number of tool calls independently explains ~10% of performance variance** (with tokens at 80% and model choice at 5%) — [ZenML LLMOps DB restating Anthropic](https://www.zenml.io/llmops-database/building-production-multi-agent-research-systems-with-claude)
- Anthropic gave agents explicit **tool-selection heuristics: "examine all available tools before starting" and "match the tool to the user's intent"** — framed as a fix for agents reaching for the wrong tool or the wrong corpus — [ZenML LLMOps DB / Anthropic](https://www.zenml.io/llmops-database/building-a-multi-agent-research-system-for-complex-information-tasks)
- **BrowseComp performance improves steadily as the tool-call budget grows**; at a budget of **16+ calls** RL-trained models separate clearly from SFT-only ones — [DeepDive, arXiv 2509.10446](https://arxiv.org/pdf/2509.10446)
- **Excessive budget forcing eventually degrades performance** — more calls is not monotonically better past a point — [arXiv 2510.06135](https://arxiv.org/pdf/2510.06135)
- Anthropic's three named techniques against context pollution: **compaction, structured note-taking, and multi-agent architectures** — [Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Compaction** = summarize a context nearing its limit and reinitialize a fresh window with the summary; the stated best practice is to **first maximize recall (capture everything relevant), then iterate to improve precision (strip superfluous content)** — [Anthropic, Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Subagents as context isolation**: specialized subagents work in clean context windows, the main agent holds only the high-level plan, and each subagent returns a **condensed 1,000-2,000 token summary** despite using tens of thousands internally — [Anthropic, Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Subagent task specs in Anthropic's system are self-contained and include **an objective, an output format, a tool list, and an explicit stop condition** — [ZenML LLMOps DB / Anthropic](https://www.zenml.io/llmops-database/building-production-multi-agent-research-systems-with-claude)
- Gemini's **asynchronous task manager maintains shared state between planner and task models, allowing graceful error recovery without restarting the entire task** — the long-horizon reliability analogue of compaction — [Deep Research Agents survey, arXiv 2506.18096](https://arxiv.org/pdf/2506.18096)
- Active 2026 work formalizes this: **CompactionRL** (RL with context compaction for long-horizon agents) — [arXiv 2607.05378](https://arxiv.org/pdf/2607.05378); **Slipstream** (trajectory-grounded validation that compaction did not drop load-bearing facts) — [arXiv 2605.08580](https://arxiv.org/pdf/2605.08580); **"Less Context, Better Agents"** — [arXiv 2606.10209](https://arxiv.org/pdf/2606.10209)

### Inferences
- Tool calls and tokens are separable levers: a system can burn many tokens on reasoning while making few retrievals, and the 80%/10% split says **both** matter independently. An orchestrator that thinks hard and searches little is leaving the second lever untouched.
- The 1-2k-token subagent return budget implies the orchestrator's synthesis quality depends on **what the subagent chose to discard**, which makes the subagent's output-format contract (and whether it is required to carry verbatim quotes + URLs, not paraphrase) a first-order quality decision. The Slipstream line of work exists because compaction silently drops load-bearing facts.
- "Excessive budget forcing degrades performance" plus "tool calls explain 10% of variance" together suggest budgets should be **task-classified rather than globally raised** — which is exactly the form of Anthropic's 3-10 / 10-15 / 10+ subagent heuristic.

### Gaps
- **No published curve of report quality vs tool-call budget for open-ended research reports.** The 16+ threshold and the degradation point are both from short-answer benchmarks.
- I found no quantified guidance on the optimal subagent return-summary size beyond Anthropic's stated 1,000-2,000 token range, and no ablation of that choice.

---

## Cross-cutting notes for the report writer

- **Most transferable checklist for an orchestrator-with-subagents system** (all from Anthropic unless noted): frontier model on the lead, cheaper tier on subagents; 3-5 subagents spawned in parallel for typical tasks, 10+ for complex; each subagent gets objective + output format + tool list + stop condition; 3-10 tool calls simple / 10-15 per subagent for comparison / more for complex; subagents return 1-2k tokens; source-quality heuristics in the prompt; a single structured judge with a 5-axis rubric rather than a committee.
- **The three numbers most worth quoting**: 80% of performance variance from token use (Anthropic); Fact Check accuracy on cited claims spanning 39-77% (arXiv 2605.06635); GPT-5-mini's 0.908 F1 as a citation verifier beating frontier judges (arXiv 2607.08700).
- **The strongest negative result**: multi-agent debate loses to plain self-consistency at equal sample count and costs 2.1-3.4x the tokens. Do not add debate rounds expecting quality.
- **Dating**: self-consistency (2022), CoVe (2023/ACL 2024), and "LLMs cannot self-correct reasoning yet" (2023) are older results included because they remain the cited baselines; everything on citation verification, rubric judging, compaction and test-time verification scaling is 2025-2026.
