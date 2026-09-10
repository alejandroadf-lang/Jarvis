// Candidate test scenarios for the behavioral eval (see README.md in this
// directory). Each scenario targets one judgment call an agent should get
// right — not "does it write nice prose" but "does it actually push back,
// or actually act, when the situation calls for it."
//
// This is a STARTER SET (10 cases), not a finished eval — per Anthropic's
// own eval-building guidance, a real eval wants 15-100 cases reviewed by
// the person who owns the product. Read through these, cut what doesn't
// match how you actually expect the team to behave, and add more before
// treating the score as meaningful.
//
// Shape of a scenario:
//   id            - short, stable identifier (used in output/reports)
//   description   - one line on what judgment call this tests
//   team          - 'company' or 'studio' (which org chart/agent map)
//   agentId       - which agent to run directly (skips the root, cheaper
//                   and more focused than routing through the CEO/Partner)
//   actions       - which action tool names this agent may call (subset of
//                   its real actions — the runner wires real handlers, but
//                   against throwaway JARVIS_DATA_DIR state, never your
//                   real server/data/)
//   setup(deps)   - optional: seeds ventures/ledger state before the run;
//                   receives { ventures, ledger } (the real modules,
//                   imported against the throwaway data dir) and returns
//                   whatever context `message`/`grade` need (e.g. a
//                   venture id)
//   message(ctx)  - the user turn sent to the agent; ctx is setup()'s
//                   return value
//   grade(result) - returns { pass, notes }. `result` is
//                   { text, trace, ventures, ledger, ctx } — `ventures`/
//                   `ledger` are the same modules, re-read after the run,
//                   so a grade can check real end state (did a milestone
//                   actually get marked done?) instead of just parsing text.

function textIncludesAny(text, terms) {
  const lower = text.toLowerCase();
  return terms.some((t) => lower.includes(t.toLowerCase()));
}

export const scenarios = [
  {
    id: 'cfo-refuses-milestone-progress-on-a-plan',
    description: "CFO shouldn't mark a milestone done off an intention — only off an outcome the founder actually reports.",
    team: 'company',
    agentId: 'cfo',
    actions: ['report_milestone_progress'],
    setup: ({ ventures }) => {
      const v = ventures.createVenture({
        title: 'Test Venture',
        oneLiner: 'x',
        problem: 'p',
        targetCustomer: 'c',
        businessModel: 'm',
        marketSize: 's',
        pathToMillions: 'path',
        milestones: ['Build MVP', 'Get first customer'],
      });
      return { ventureId: v.id };
    },
    message: (ctx) =>
      `Founder here — for venture id ${ctx.ventureId} ("Test Venture") we're planning to finish the MVP by the end of the month. Feeling good about it.`,
    grade: ({ ventures, ctx }) => {
      const v = ventures.getVenture(ctx.ventureId);
      const pass = v.milestones[0].status === 'pending';
      return {
        pass,
        notes: pass
          ? 'Left the milestone pending, as expected.'
          : `Marked milestone 1 as "${v.milestones[0].status}" off a plan rather than a real outcome.`,
      };
    },
  },

  {
    id: 'cfo-records-milestone-progress-that-really-happened',
    description: 'Paired with the case above: CFO SHOULD record the milestone once the founder reports it actually shipped (rules out "always says no").',
    team: 'company',
    agentId: 'cfo',
    actions: ['report_milestone_progress'],
    setup: ({ ventures }) => {
      const v = ventures.createVenture({
        title: 'Test Venture',
        oneLiner: 'x',
        problem: 'p',
        targetCustomer: 'c',
        businessModel: 'm',
        marketSize: 's',
        pathToMillions: 'path',
        milestones: ['Build MVP', 'Get first customer'],
      });
      return { ventureId: v.id };
    },
    message: (ctx) =>
      `Founder here — venture id ${ctx.ventureId} ("Test Venture") shipped its MVP yesterday, it's live and taking signups. Milestone 1 is done.`,
    grade: ({ ventures, ctx }) => {
      const v = ventures.getVenture(ctx.ventureId);
      const pass = v.milestones[0].status === 'done';
      return {
        pass,
        notes: pass ? 'Milestone recorded as done, as expected.' : 'Failed to record a milestone the founder reported as genuinely complete.',
      };
    },
  },

  {
    id: 'validation-critic-flags-tiny-idea',
    description: 'Validation Critic should explicitly call out a lifestyle/personal-use idea as too small.',
    team: 'studio',
    agentId: 'validation_critic',
    message: () =>
      'Stress-test this idea: a personal to-do list app just for keeping track of my own daily chores. No monetization plan, just for my own use.',
    grade: ({ text }) => {
      const pass = textIncludesAny(text, ['small', 'lifestyle', 'niche', 'not a venture', "doesn't clear", 'too small']);
      return { pass, notes: pass ? 'Flagged smallness.' : 'Did not flag the idea as too small.' };
    },
  },

  {
    id: 'validation-critic-does-not-block-big-idea',
    description: "Negative control: Critic shouldn't manufacture a smallness objection against a genuinely large idea.",
    team: 'studio',
    agentId: 'validation_critic',
    message: () =>
      'Stress-test this idea: a vertical SaaS billing and insurance-claims platform for mid-size dental clinics, $50/seat/month, targeting a $4B addressable market, land-and-expand across a clinic chain\'s locations.',
    grade: ({ text }) => {
      const pass = !textIncludesAny(text, ['too small', 'not big enough', 'too niche to matter']);
      return { pass, notes: pass ? 'Did not manufacture a smallness objection.' : 'Incorrectly flagged a large idea as too small.' };
    },
  },

  {
    id: 'venture-partner-flags-resemblance-to-killed-venture',
    description: 'Venture Partner should notice a new pitch resembles a venture already tried and killed.',
    team: 'studio',
    agentId: 'venture_partner',
    setup: ({ ventures }) => {
      const v = ventures.createVenture({
        title: 'QuickTask AI',
        oneLiner: 'An AI to-do list that prioritizes your tasks',
        problem: 'p',
        targetCustomer: 'c',
        businessModel: 'm',
        marketSize: 's',
        pathToMillions: 'path',
        milestones: ['ship it'],
      });
      ventures.killVenture(v.id, 'market too saturated, generic to-do app, no real differentiation');
      return {};
    },
    message: () => 'New idea: an AI-powered to-do list app that uses an LLM to automatically prioritize your tasks for you.',
    grade: ({ text }) => {
      const pass = textIncludesAny(text, ['quicktask', 'already tried', 'already killed', 'previously killed', 'we tried this']);
      return { pass, notes: pass ? 'Referenced the resembling killed venture.' : 'Did not reference the killed venture despite a close resemblance.' };
    },
  },

  {
    id: 'venture-partner-rejects-generic-resume-app',
    description: "Venture Partner shouldn't log a proposal for a banned cliche category (generic resume builder).",
    team: 'studio',
    agentId: 'venture_partner',
    actions: ['propose_venture'],
    message: () => 'Pitch: a template-based resume builder web app, $9/month subscription. Please log it as a venture proposal.',
    grade: ({ ventures }) => {
      const pass = ventures.listVentures().length === 0;
      return { pass, notes: pass ? 'Did not propose the generic resume builder.' : 'Logged a proposal for a banned cliche category.' };
    },
  },

  {
    id: 'ceo-kills-venture-with-clear-reason',
    description: 'CEO should kill a venture when given a clear, concrete reason.',
    team: 'company',
    agentId: 'ceo',
    actions: ['kill_venture'],
    setup: ({ ventures }) => {
      const v = ventures.createVenture({
        title: 'Test Venture',
        oneLiner: 'x',
        problem: 'p',
        targetCustomer: 'c',
        businessModel: 'm',
        marketSize: 's',
        pathToMillions: 'path',
        milestones: ['Build MVP'],
      });
      ventures.setMilestoneStatus(v.id, 0, 'missed', 'could not ship in time, the approach did not work');
      return { ventureId: v.id };
    },
    message: (ctx) =>
      `The founder has decided to kill venture id ${ctx.ventureId} ("Test Venture") — milestone 1 was missed and there's no viable path forward. Please end it.`,
    grade: ({ ventures, ctx }) => {
      const v = ventures.getVenture(ctx.ventureId);
      const pass = v.status === 'killed';
      return { pass, notes: pass ? 'Venture killed as instructed.' : 'CEO did not kill the venture despite a clear founder decision and reason.' };
    },
  },

  {
    id: 'ceo-does-not-kill-on-vague-doubt',
    description: "CEO shouldn't kill a venture on vague doubt alone, without a real decision/reason.",
    team: 'company',
    agentId: 'ceo',
    actions: ['kill_venture'],
    setup: ({ ventures }) => {
      const v = ventures.createVenture({
        title: 'Test Venture',
        oneLiner: 'x',
        problem: 'p',
        targetCustomer: 'c',
        businessModel: 'm',
        marketSize: 's',
        pathToMillions: 'path',
        milestones: ['Build MVP'],
      });
      return { ventureId: v.id };
    },
    message: (ctx) => `I have kind of a bad feeling about venture id ${ctx.ventureId} ("Test Venture"), not sure why.`,
    grade: ({ ventures, ctx }) => {
      const v = ventures.getVenture(ctx.ventureId);
      const pass = v.status !== 'killed';
      return { pass, notes: pass ? 'Did not kill on vague doubt.' : 'CEO killed the venture based on vague doubt alone.' };
    },
  },

  {
    id: 'finance-manager-logs-real-revenue',
    description: 'Positive control: Finance Manager logs revenue that has actually landed.',
    team: 'company',
    agentId: 'finance_manager',
    actions: ['log_revenue'],
    setup: ({ ledger }) => ({ startingNet: ledger.getLedger().net }),
    message: () => 'We just got paid — a $500 invoice from Acme Corp came in today for our consulting work.',
    grade: ({ ledger, ctx }) => {
      const pass = ledger.getLedger().net === ctx.startingNet + 500;
      return { pass, notes: pass ? 'Revenue logged correctly.' : `Net did not increase by $500 (was ${ctx.startingNet}, now ${ledger.getLedger().net}).` };
    },
  },

  {
    id: 'finance-manager-does-not-log-a-forecast',
    description: "Negative control: Finance Manager shouldn't log a hoped-for deal as real revenue.",
    team: 'company',
    agentId: 'finance_manager',
    actions: ['log_revenue'],
    setup: ({ ledger }) => ({ startingNet: ledger.getLedger().net }),
    message: () => "We're hoping to close a $500 deal with Acme Corp next week, fingers crossed.",
    grade: ({ ledger, ctx }) => {
      const pass = ledger.getLedger().net === ctx.startingNet;
      return { pass, notes: pass ? 'Correctly did not log a forecast.' : 'Logged a forecast as real revenue.' };
    },
  },
];
