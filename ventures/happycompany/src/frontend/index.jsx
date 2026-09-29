// The Team health page, shared by the Jira project page and the Confluence
// space page. UI Kit only: no custom iframe, no external assets, which keeps
// the app inside "Runs on Atlassian".
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Heading,
  Inline,
  Label,
  LineChart,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Stack,
  Text,
  TextArea,
  Textfield,
  Toggle,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const APPEARANCE = { good: 'success', watch: 'moved', act: 'removed', unknown: 'default' };
const WORD = { good: 'Fine', watch: 'Watch', act: 'Act now', unknown: 'No data' };
const ARROW = { up: 'improving', down: 'worsening', flat: 'steady' };

// Labels for the per-signal switches, in the order the score uses them.
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
  itemsMedian: 'Different items touched in a day',
  burstyShare: 'Days broken into many bursts',
  mentionsPerPersonDay: 'Mentions received per person per day',
  mentionTopShare: 'Mentions landing on one person',
  dueCrunch: 'Due dates bunching into one week',
  highPriorityShare: 'Open work marked High or Highest',
  reopenRate: 'Work reopened after being done',
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

function Actions({ actions }) {
  if (!actions?.length) return null;
  return (
    <SectionMessage title="Three things to change this week" appearance="warning">
      <Stack space="space.100">
        {actions.map((a) => (
          <Text key={a.key}>
            {a.text} {a.action}
          </Text>
        ))}
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
          individuals; the grade needs {minGroup} or more active people.
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
            Team health {current.score} / 100, week {current.week}, {current.contributors} people active
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
        ariaLabel={`Team health ${current.score} of 100`}
        appearance={current.status === 'good' ? 'success' : 'default'}
      />
      <Actions actions={current.actions} />
      <Inline space="space.400" shouldWrap>
        {Object.values(current.dimensions).map((dimension) => (
          <Dimension key={dimension.key} dimension={dimension} />
        ))}
      </Inline>
    </Stack>
  );
}

function History({ weeks }) {
  const points = weeks.filter((w) => w.score !== null).map((w) => [w.week, w.score]);
  if (points.length < 2) return null;
  return <LineChart data={points} xAccessor={0} yAccessor={1} title="Weekly team health" height={220} />;
}

// Controlled fields rather than a form library: what is on screen is exactly
// what gets sent, and the backend validates every field again.
function Settings({ settings, indicatorKeys, onSaved }) {
  const [form, setForm] = useState({
    timeZone: settings.timeZone,
    quietStart: String(settings.quietStart),
    quietEnd: String(settings.quietEnd),
    lateStart: String(settings.lateStart),
    lateEnd: String(settings.lateEnd),
    weekendDays: settings.weekendDays.join(','),
    holidays: (settings.holidays || []).join('\n'),
    longSpanHours: String(settings.longSpanHours),
    signals: { ...(settings.signals || {}) },
  });
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const field = (name) => (event) => setForm({ ...form, [name]: event.target.value });
  const toggle = (key) => (event) => setForm({ ...form, signals: { ...form.signals, [key]: Boolean(event.target.checked) } });

  const save = async () => {
    setSaving(true);
    try {
      const saved = await invoke('saveSettings', { settings: form });
      await onSaved(saved);
      setMessage({ appearance: 'success', text: 'Saved. New activity is classified with these settings.' });
    } catch (err) {
      setMessage({ appearance: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack space="space.150">
      <Heading size="small">Settings</Heading>
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
      </Inline>
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

  return (
    <Stack space="space.400">
      <Scorecard report={report} />
      <History weeks={report.weeks} />
      <Box>
        <Stack space="space.050">
          <Heading size="xsmall">How to read this</Heading>
          {report.notes.map((note) => (
            <Text key={note}>{note}</Text>
          ))}
          <Text>
            Hours and recovery, workload, fragmentation, deadline pressure and rework are the psychosocial hazards ISO
            45003 asks employers to manage that leave traces in Jira and Confluence. The others (job control, support,
            role clarity, change) do not, and are not scored.
          </Text>
        </Stack>
      </Box>
      <Settings key={report.generatedAt} settings={report.settings} indicatorKeys={report.indicatorKeys} onSaved={async () => load()} />
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
