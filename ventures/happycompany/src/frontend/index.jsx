// The Team health page, shared by the Jira project page and the Confluence
// space page. UI Kit only: no custom iframe, no external assets, which keeps
// the app inside "Runs on Atlassian".
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Form,
  Heading,
  Inline,
  Label,
  LineChart,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Stack,
  Text,
  Textfield,
  useForm,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const APPEARANCE = { good: 'success', watch: 'moved', act: 'removed', unknown: 'default' };
const WORD = { good: 'Fine', watch: 'Watch', act: 'Act now', unknown: 'No data' };
const ARROW = { up: 'improving', down: 'worsening', flat: 'steady' };

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
            {trend.delta === null ? 'Not enough earlier weeks for a trend yet.' : `Trend: ${ARROW[trend.direction]} (${trend.delta > 0 ? '+' : ''}${trend.delta} against the last four weeks).`}
          </Text>
        </Stack>
      </Inline>
      <ProgressBar value={current.score / 100} ariaLabel={`Team health ${current.score} of 100`} appearance={current.status === 'good' ? 'success' : 'default'} />
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

function Settings({ settings, onSaved }) {
  const { handleSubmit, register, getFieldId } = useForm();
  const [message, setMessage] = useState(null);
  const save = async (values) => {
    try {
      await onSaved(await invoke('saveSettings', { settings: values }));
      setMessage({ appearance: 'success', text: 'Saved. New activity is classified with these settings.' });
    } catch (err) {
      setMessage({ appearance: 'error', text: err.message });
    }
  };
  return (
    <Form onSubmit={handleSubmit(save)}>
      <Stack space="space.150">
        <Heading size="small">Settings</Heading>
        <Label labelFor={getFieldId('timeZone')}>Team time zone (IANA name, e.g. Europe/Berlin)</Label>
        <Textfield {...register('timeZone')} defaultValue={settings.timeZone} />
        <Label labelFor={getFieldId('quietStart')}>Quiet hours start (0–23)</Label>
        <Textfield {...register('quietStart')} type="number" defaultValue={String(settings.quietStart)} />
        <Label labelFor={getFieldId('quietEnd')}>Quiet hours end (0–23)</Label>
        <Textfield {...register('quietEnd')} type="number" defaultValue={String(settings.quietEnd)} />
        <Label labelFor={getFieldId('weekendDays')}>Weekend days, 0 = Sunday … 6 = Saturday</Label>
        <Textfield {...register('weekendDays')} defaultValue={settings.weekendDays.join(',')} />
        <Inline space="space.100">
          <Button appearance="primary" type="submit">
            Save settings
          </Button>
        </Inline>
        {message && (
          <SectionMessage appearance={message.appearance}>
            <Text>{message.text}</Text>
          </SectionMessage>
        )}
      </Stack>
    </Form>
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
            Working hours and workload are two of the psychosocial hazards ISO 45003 asks employers to manage. The
            others (job control, support, role clarity, change) do not show in Jira or Confluence and are not scored.
          </Text>
        </Stack>
      </Box>
      <Settings settings={report.settings} onSaved={async () => load()} />
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
