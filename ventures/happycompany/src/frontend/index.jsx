// The Team health page, shared by the Jira project page and the Confluence
// space page. UI Kit only: no custom iframe, no external assets, which keeps
// the app inside "Runs on Atlassian".
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Checkbox,
  Heading,
  Inline,
  Label,
  LineChart,
  List,
  ListItem,
  Lozenge,
  ProgressBar,
  RadioGroup,
  SectionMessage,
  Select,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  TextArea,
  Textfield,
  Toggle,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const APPEARANCE = { good: 'success', watch: 'moved', act: 'removed', unknown: 'default' };
const WORD = { good: 'Fine', watch: 'Watch', act: 'Act now', unknown: 'No data' };
const ARROW = { up: 'improving', down: 'worsening', flat: 'steady' };

const SIGNAL_LABELS = {
  afterHoursShare: 'Activity outside working hours',
  lateShare: 'Activity late at night',
  weekendShare: 'Activity on weekends and holidays',
  longSpanShare: 'Long days',
  streakShare: 'People without a day off',
  noRestShare: 'People without a week away in three months',
  concentration: 'Work concentrated on one person',
  overloadedShare: 'People carrying far more open work than the team',
  overdueShare: 'Overdue open work',
  wipMean: 'Work in progress per person',
  carryOverShare: 'Sprint work carried over',
  inflowRatio: 'New work arriving faster than it is finished',
  itemsMedian: 'Different items touched in a day',
  burstyShare: 'Days broken into many bursts',
  mentionsPerPersonDay: 'Mentions received per person per day',
  mentionTopShare: 'Mentions landing on one person',
  dueCrunch: 'Due dates bunching into one week',
  highPriorityShare: 'Open work marked High or Highest',
  unplannedShare: 'Work created mid-sprint',
  dueMoveRate: 'Due dates being moved',
  loadSurge: 'Workload surge this week',
  reopenRate: 'Work reopened after being done',
  blockedShare: 'Enabler: work in progress that is blocked',
  reprioritisationRate: 'Enabler: priorities changing mid-flight',
  selfAssignedShare: 'Enabler: work people pick up themselves',
  soloShare: 'Enabler: work only one person touches',
};

const SCALE_LABELS = {
  agree: ['Strongly disagree', 'Disagree', 'Neither', 'Agree', 'Strongly agree'],
  frequency: ['Never or almost never', 'Seldom', 'Sometimes', 'Often', 'Always'],
  degree: ['To a very low degree', 'To a low degree', 'Somewhat', 'To a high degree', 'To a very high degree'],
};

function Indicator({ indicator }) {
  return (
    <Inline space="space.100" alignBlock="center">
      <Lozenge appearance={APPEARANCE[indicator.status]}>{WORD[indicator.status]}</Lozenge>
      <Text>{indicator.text}</Text>
    </Inline>
  );
}

function Dimension({ dimension }) {
  if (!dimension.indicators.length) return null;
  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Heading size="small">{dimension.label}</Heading>
        <Lozenge appearance={APPEARANCE[dimension.status]} isBold>
          {dimension.score === null ? 'No data' : `${dimension.score} / 100`}
        </Lozenge>
      </Inline>
      {dimension.indicators.map((indicator) => (
        <Indicator key={indicator.key} indicator={indicator} />
      ))}
    </Stack>
  );
}

function PathToNext({ path }) {
  if (!path || !path.target || !path.levers.length) return null;
  const best = path.levers[0];
  return (
    <SectionMessage title={`What gets you to ${path.target}`} appearance="information">
      <Stack space="space.075">
        <Text>{`${path.pointsNeeded} points to go.`}</Text>
        {path.levers.map((l) => (
          <Text key={l.key}>
            {`${l.label}: bringing it to healthy lifts the score to ${l.liftsTo}${l.reaches ? `, which is ${path.target}.` : '.'}`}
          </Text>
        ))}
        {!best.reaches && path.pair?.reaches && <Text>{'No single change gets there; the top two together would.'}</Text>}
      </Stack>
    </SectionMessage>
  );
}

function Scorecard({ report }) {
  const { current, trend, minGroup } = report;
  if (!current.hasData) {
    return (
      <SectionMessage title="Collecting" appearance="information">
        <Text>
          Nothing has been counted for this {report.product === 'jira' ? 'project' : 'space'} yet. Figures appear once
          people have been active for a few days.
        </Text>
      </SectionMessage>
    );
  }
  if (current.suppressed || current.score === null) {
    return (
      <SectionMessage title="Too few people to show" appearance="information">
        <Text>
          Fewer than {minGroup} people were active in week {current.week}, so no figures are shown. This protects
          individuals.
        </Text>
      </SectionMessage>
    );
  }
  return (
    <Stack space="space.200">
      <Inline space="space.200" alignBlock="center">
        <Heading size="xlarge">{current.grade}</Heading>
        <Stack space="space.050">
          <Text>
            Working conditions {current.score} / 100, week {current.week}, {current.contributors} people active
          </Text>
          <Text>
            {trend.delta === null
              ? 'Not enough earlier weeks for a trend yet.'
              : `Trend: ${ARROW[trend.direction]} (${trend.delta > 0 ? '+' : ''}${trend.delta} against the last four weeks).`}
          </Text>
        </Stack>
      </Inline>
      <ProgressBar
        value={current.score / 100}
        ariaLabel={`Working conditions ${current.score} of 100`}
        appearance={current.status === 'good' ? 'success' : 'default'}
      />
      {report.checks.map((c) => (
        <SectionMessage key={c.key} title="Check this improvement" appearance="warning">
          <Text>{c.text}</Text>
        </SectionMessage>
      ))}
      <PathToNext path={report.path} />
      <Inline space="space.400" shouldWrap>
        {Object.values(current.dimensions).map((dimension) => (
          <Dimension key={dimension.key} dimension={dimension} />
        ))}
      </Inline>
    </Stack>
  );
}

function Enablers({ enablers }) {
  if (!enablers || !enablers.indicators.length) return null;
  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Heading size="small">What helps this team (enablers, not part of the grade)</Heading>
        <Lozenge appearance={APPEARANCE[enablers.status]} isBold>
          {enablers.score === null ? 'No data' : `${enablers.score} / 100`}
        </Lozenge>
      </Inline>
      {enablers.indicators.map((i) => (
        <Stack key={i.key} space="space.025">
          <Indicator indicator={i} />
          {i.action && <Text>{i.action}</Text>}
        </Stack>
      ))}
    </Stack>
  );
}

function Pulse({ pulse, reload }) {
  const [answers, setAnswers] = useState({});
  const [message, setMessage] = useState(null);
  if (!pulse || pulse.cadence === 'off') {
    return <Text>The team pulse is off. A project or space administrator can switch it on in Settings.</Text>;
  }
  const submit = async () => {
    try {
      await invoke('answerPulse', { answers });
      setMessage({ appearance: 'success', text: 'Thank you. Only counts are kept; your answers cannot be traced back to you.' });
      await reload();
    } catch (err) {
      setMessage({ appearance: 'error', text: err.message });
    }
  };
  const r = pulse.results;
  return (
    <Stack space="space.300">
      <SectionMessage title="Anonymous, and only counted" appearance="information">
        <Text>
          {`Answers are stored only as totals per statement. Results appear when ${pulse.cadence === 'monthly' ? 'the month' : 'the quarter'} closes, and only for statements at least ${pulse.minGroup} people answered. There is no free text.`}
        </Text>
      </SectionMessage>
      {pulse.answered ? (
        <Text>{`You have answered this period's pulse. ${pulse.answersSoFar} answers so far.`}</Text>
      ) : (
        <Stack space="space.200">
          <Text>{`${pulse.answersSoFar} answers so far this period. Skip any statement you prefer not to answer.`}</Text>
          {pulse.items.map((item) => (
            <Stack key={item.key} space="space.050">
              <Text>{item.text}</Text>
              <RadioGroup
                name={`hc-pulse-${item.key}`}
                options={SCALE_LABELS[item.scale].map((label, i) => ({ label, value: String(i + 1) }))}
                value={answers[item.key] ? String(answers[item.key]) : undefined}
                onChange={(e) => setAnswers({ ...answers, [item.key]: Number(e.target.value) })}
              />
            </Stack>
          ))}
          <Inline space="space.100">
            <Button appearance="primary" onClick={submit} isDisabled={!Object.keys(answers).length}>
              Send anonymously
            </Button>
          </Inline>
        </Stack>
      )}
      <Stack space="space.100">
        <Heading size="small">{`Results for ${pulse.closedPeriod}`}</Heading>
        {r.shown ? (
          <Stack space="space.075">
            <Text>{`${r.n} people answered.`}</Text>
            {r.items.map((i) => (
              <Text key={i.key}>
                {i.favourable === null
                  ? `${i.text} Average ${i.mean} of 5.`
                  : `${i.text} ${Math.round(i.favourable * 100)}% agree (average ${i.mean} of 5).`}
              </Text>
            ))}
            {r.cbi !== null && r.cbi !== undefined && <Text>{`Work-related burnout scale (Copenhagen Burnout Inventory): ${r.cbi} of 100.`}</Text>}
          </Stack>
        ) : (
          <Text>{`Not shown: fewer than ${pulse.minGroup} people answered (${r.n}).`}</Text>
        )}
      </Stack>
      {message && (
        <SectionMessage appearance={message.appearance}>
          <Text>{message.text}</Text>
        </SectionMessage>
      )}
    </Stack>
  );
}

function History({ weeks }) {
  const points = weeks.filter((w) => w.score !== null).map((w) => [w.week, w.score]);
  if (points.length < 2) return null;
  return <LineChart data={points} xAccessor={0} yAccessor={1} title="Weekly working conditions" height={220} />;
}

function Badges({ badges }) {
  if (!badges.length) return null;
  return (
    <Stack space="space.100">
      <Heading size="small">Earned by this team</Heading>
      <Inline space="space.100" shouldWrap>
        {badges.map((b) => (
          <Lozenge key={b.key} appearance="success" isBold>
            {b.times > 1 ? `${b.label} ×${b.times}` : b.label}
          </Lozenge>
        ))}
      </Inline>
      {badges.map((b) => (
        <Text key={`${b.key}-t`}>{`${b.label}: ${b.text}`}</Text>
      ))}
      <Text>Badges reward changes the team made, never a grade level. Only this team sees them.</Text>
    </Stack>
  );
}

function Loop({ report, reload }) {
  const { current, loop } = report;
  const [picked, setPicked] = useState([]);
  const [message, setMessage] = useState(null);
  const committedKeys = new Set(loop.committed.map((i) => i.key));
  const open = current.actions.filter((a) => !committedKeys.has(a.key));
  const run = async (fn, ok) => {
    try {
      await fn();
      setMessage({ appearance: 'success', text: ok });
      setPicked([]);
      await reload();
    } catch (err) {
      setMessage({ appearance: 'error', text: err.message });
    }
  };

  return (
    <Stack space="space.300">
      {loop.toClose.map((w) => (
        <SectionMessage key={w.week} title={`Did it happen? Week ${w.week}`} appearance="information">
          <Stack space="space.100">
            {w.items.map((i) => (
              <Inline key={i.key} space="space.100" alignBlock="center" shouldWrap>
                <Text>{i.action}</Text>
                <Button onClick={() => run(() => invoke('closeAction', { week: w.week, key: i.key, done: true }), 'Recorded as done.')}>
                  Done
                </Button>
                <Button
                  appearance="subtle"
                  onClick={() => run(() => invoke('closeAction', { week: w.week, key: i.key, done: false }), 'Recorded as not done.')}
                >
                  Not this time
                </Button>
              </Inline>
            ))}
          </Stack>
        </SectionMessage>
      ))}

      <Stack space="space.100">
        <Heading size="small">This week</Heading>
        {loop.committed.length > 0 && (
          <List type="unordered">
            {loop.committed.map((i) => (
              <ListItem key={i.key}>
                <Text>{`${i.action}${i.done === true ? ' (done)' : i.done === false ? ' (not done)' : ''}`}</Text>
              </ListItem>
            ))}
          </List>
        )}
        {open.length > 0 && loop.committed.length < 3 && (
          <Stack space="space.100">
            <Text>Pick what the team will try this week. You will be asked next week whether it happened.</Text>
            {open.map((a) => (
              <Checkbox
                key={a.key}
                id={`hc-pick-${a.key}`}
                label={`${a.text} ${a.action}`}
                isChecked={picked.includes(a.key)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, a.key] : picked.filter((k) => k !== a.key))}
              />
            ))}
            <Inline space="space.100">
              <Button
                appearance="primary"
                isDisabled={!picked.length}
                onClick={() => run(() => invoke('commitActions', { keys: picked }), 'Committed. See you next week.')}
              >
                Commit
              </Button>
            </Inline>
          </Stack>
        )}
        {!current.actions.length && <Text>Nothing needs changing this week.</Text>}
      </Stack>

      <Stack space="space.100">
        <Heading size="small">Track record</Heading>
        <Text>
          {loop.completion.rate === null
            ? 'No actions closed yet.'
            : `${loop.completion.done} of ${loop.completion.closed} closed actions done (${Math.round(loop.completion.rate * 100)}%).`}
        </Text>
        <Text>{loop.streak.length ? `Current streak: ${loop.streak.length} weeks with an action done.` : 'No streak yet.'}</Text>
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Button appearance="subtle" onClick={() => run(() => invoke('freezeWeek'), 'This week is marked as a launch or incident week.')}>
            Mark this week as a launch or incident week
          </Button>
          <Text>It neither breaks nor extends the streak. Two a quarter.</Text>
        </Inline>
      </Stack>

      <Badges badges={report.badges} />

      {message && (
        <SectionMessage appearance={message.appearance}>
          <Text>{message.text}</Text>
        </SectionMessage>
      )}
    </Stack>
  );
}

function WhatWeMeasure({ t }) {
  return (
    <Stack space="space.300">
      <SectionMessage title="How this may be used" appearance="warning">
        <Text>{t.useBan}</Text>
      </SectionMessage>
      <Stack space="space.100">
        <Heading size="small">What is measured</Heading>
        {t.measured
          .filter((d) => d.signals.length)
          .map((d) => (
            <Text key={d.key}>{`${d.label}: ${d.signals.join('; ')}.`}</Text>
          ))}
      </Stack>
      <Stack space="space.100">
        <Heading size="small">What is never measured</Heading>
        <List type="unordered">
          {t.neverMeasured.map((l) => (
            <ListItem key={l}>
              <Text>{l}</Text>
            </ListItem>
          ))}
        </List>
      </Stack>
      <Stack space="space.100">
        <Heading size="small">The rules</Heading>
        <List type="unordered">
          {t.rules.map((l) => (
            <ListItem key={l}>
              <Text>{l}</Text>
            </ListItem>
          ))}
        </List>
      </Stack>
      <Text>{t.limits}</Text>
      <Text>
        These are the psychosocial hazards ISO 45003 asks employers to manage that leave traces in Jira and Confluence.
        The others (job control, support, relationships, role clarity, change) do not, and are not scored.
      </Text>
    </Stack>
  );
}

// Controlled fields rather than a form library: what is on screen is exactly
// what gets sent, and the backend validates every field again.
function Settings({ settings, indicatorKeys, onSaved }) {
  // indicatorKeys includes the enabler signals, which can be switched off too.
  const [form, setForm] = useState({
    timeZone: settings.timeZone,
    quietStart: String(settings.quietStart),
    quietEnd: String(settings.quietEnd),
    lateStart: String(settings.lateStart),
    lateEnd: String(settings.lateEnd),
    weekendDays: settings.weekendDays.join(','),
    holidays: (settings.holidays || []).join('\n'),
    longSpanHours: String(settings.longSpanHours),
    minGroup: String(settings.minGroup ?? 5),
    digest: settings.digest === 'on' ? 'on' : 'off',
    pulse: settings.pulse || 'off',
    validation: settings.validation === true,
    signals: { ...(settings.signals || {}) },
  });
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const field = (name) => (event) => setForm({ ...form, [name]: event.target.value });
  const toggle = (key) => (event) => setForm({ ...form, signals: { ...form.signals, [key]: Boolean(event.target.checked) } });

  const save = async () => {
    setSaving(true);
    try {
      await onSaved(await invoke('saveSettings', { settings: form }));
      setMessage({ appearance: 'success', text: 'Saved. New activity is classified with these settings.' });
    } catch (err) {
      setMessage({ appearance: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack space="space.150">
      <Text>Only project or space administrators can save these settings. Every change is recorded in the audit trail.</Text>
      <Label labelFor="hc-tz">Team time zone (IANA name, e.g. Europe/Berlin)</Label>
      <Textfield id="hc-tz" value={form.timeZone} onChange={field('timeZone')} />
      <Inline space="space.200" shouldWrap>
        <Stack space="space.050">
          <Label labelFor="hc-qs">Quiet hours start (0–23)</Label>
          <Textfield id="hc-qs" type="number" value={form.quietStart} onChange={field('quietStart')} />
        </Stack>
        <Stack space="space.050">
          <Label labelFor="hc-qe">Quiet hours end (0–23)</Label>
          <Textfield id="hc-qe" type="number" value={form.quietEnd} onChange={field('quietEnd')} />
        </Stack>
        <Stack space="space.050">
          <Label labelFor="hc-ls">Late night start (0–23)</Label>
          <Textfield id="hc-ls" type="number" value={form.lateStart} onChange={field('lateStart')} />
        </Stack>
        <Stack space="space.050">
          <Label labelFor="hc-le">Late night end (0–23)</Label>
          <Textfield id="hc-le" type="number" value={form.lateEnd} onChange={field('lateEnd')} />
        </Stack>
        <Stack space="space.050">
          <Label labelFor="hc-span">A long day is this many hours first to last action</Label>
          <Textfield id="hc-span" type="number" value={form.longSpanHours} onChange={field('longSpanHours')} />
        </Stack>
        <Stack space="space.050">
          <Label labelFor="hc-min">Show nothing for fewer than this many people (5 to 10)</Label>
          <Textfield id="hc-min" type="number" value={form.minGroup} onChange={field('minGroup')} />
        </Stack>
      </Inline>
      <Toggle
        id="hc-digest"
        label="Post a weekly digest here every Monday (a Jira issue labelled happy-company, or a Confluence blog post)"
        isChecked={form.digest === 'on'}
        onChange={(e) => setForm({ ...form, digest: e.target.checked ? 'on' : 'off' })}
      />
      <Label labelFor="hc-pulse">Anonymous team pulse</Label>
      <Select
        inputId="hc-pulse"
        options={[
          { label: 'Off', value: 'off' },
          { label: 'Monthly', value: 'monthly' },
          { label: 'Quarterly', value: 'quarterly' },
        ]}
        value={{ label: form.pulse === 'monthly' ? 'Monthly' : form.pulse === 'quarterly' ? 'Quarterly' : 'Off', value: form.pulse }}
        onChange={(option) => setForm({ ...form, pulse: option?.value || 'off' })}
      />
      <Toggle
        id="hc-validation"
        label="Validation mode: add the seven-item Copenhagen Burnout Inventory to the pulse, to check the grade against a validated scale"
        isChecked={form.validation}
        onChange={(e) => setForm({ ...form, validation: Boolean(e.target.checked) })}
      />
      <Label labelFor="hc-we">Weekend days, 0 = Sunday … 6 = Saturday</Label>
      <Textfield id="hc-we" value={form.weekendDays} onChange={field('weekendDays')} />
      <Label labelFor="hc-hol">Public holidays, one date per line (YYYY-MM-DD). Activity on them counts like weekend work.</Label>
      <TextArea id="hc-hol" value={form.holidays} onChange={field('holidays')} />
      <Heading size="xsmall">Signals</Heading>
      <Text>Switch a signal off and it leaves the score entirely. Works councils often want to agree the exact set.</Text>
      <Stack space="space.050">
        {indicatorKeys.map((key) => (
          <Toggle key={key} id={`hc-sig-${key}`} label={SIGNAL_LABELS[key] || key} isChecked={form.signals[key] !== false} onChange={toggle(key)} />
        ))}
      </Stack>
      <Inline space="space.100">
        <Button appearance="primary" onClick={save} isDisabled={saving}>
          Save settings
        </Button>
      </Inline>
      {message && (
        <SectionMessage appearance={message.appearance}>
          <Text>{message.text}</Text>
        </SectionMessage>
      )}
    </Stack>
  );
}

function App() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  const load = () => invoke('teamHealth').then(setReport).catch((err) => setError(err.message));
  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <SectionMessage title="Team health could not load" appearance="error">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!report) return <Text>Loading team health…</Text>;

  const toClose = report.loop.toClose.reduce((n, w) => n + w.items.length, 0);
  return (
    <Tabs id="hc-tabs">
      <TabList>
        <Tab>Working conditions</Tab>
        <Tab>{toClose ? `Actions (${toClose} to close)` : 'Actions'}</Tab>
        <Tab>Team pulse</Tab>
        <Tab>What we measure</Tab>
        <Tab>Settings</Tab>
      </TabList>
      <TabPanel>
        <Box padding="space.200">
          <Stack space="space.400">
            <Scorecard report={report} />
            <Enablers enablers={report.enablers} />
            <History weeks={report.weeks} />
            <Stack space="space.050">
              {report.notes.map((note) => (
                <Text key={note}>{note}</Text>
              ))}
            </Stack>
          </Stack>
        </Box>
      </TabPanel>
      <TabPanel>
        <Box padding="space.200">
          <Loop report={report} reload={load} />
        </Box>
      </TabPanel>
      <TabPanel>
        <Box padding="space.200">
          <Pulse pulse={report.pulse} reload={load} />
        </Box>
      </TabPanel>
      <TabPanel>
        <Box padding="space.200">
          <WhatWeMeasure t={report.transparency} />
        </Box>
      </TabPanel>
      <TabPanel>
        <Box padding="space.200">
          <Settings
            key={report.generatedAt}
            settings={report.settings}
            indicatorKeys={[...report.indicatorKeys, ...report.enablerKeys]}
            onSaved={async () => load()}
          />
        </Box>
      </TabPanel>
    </Tabs>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
