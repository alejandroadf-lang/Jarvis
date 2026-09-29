// The organisation view: coverage, how many teams work in sustainable
// conditions, recovery, action, and who could use support. Never a ranking.
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Heading,
  Inline,
  Label,
  List,
  ListItem,
  Lozenge,
  SectionMessage,
  Stack,
  Text,
  TextArea,
  Textfield,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const pct = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);

function Figure({ label, value, detail }) {
  return (
    <Box padding="space.150">
      <Stack space="space.050">
        <Text>{label}</Text>
        <Heading size="large">{value}</Heading>
        {detail && <Text>{detail}</Text>}
      </Stack>
    </Box>
  );
}

function Summary({ s }) {
  return (
    <Stack space="space.300">
      <Inline space="space.200" shouldWrap>
        <Figure label="Teams in sustainable conditions (C or better)" value={pct(s.sustainableShare)} detail={`${s.graded} teams graded this week`} />
        <Figure label="Coverage" value={pct(s.coverage)} detail={`${s.graded} of ${s.teams} teams graded; ${s.suppressed} too small to show`} />
        <Figure
          label="Median weeks to recover from D or E"
          value={s.medianWeeksToRecover === null ? '–' : String(s.medianWeeksToRecover)}
          detail={`${s.recoveries} recoveries seen`}
        />
        <Figure label="Committed actions done" value={pct(s.actionCompletion)} detail={`${pct(s.actingTeamsShare)} of teams have committed to an action`} />
      </Inline>
      <Stack space="space.100">
        <Heading size="small">Grades this week</Heading>
        <Inline space="space.100" shouldWrap>
          {['A', 'B', 'C', 'D', 'E'].map((g) => (
            <Lozenge key={g} appearance={g <= 'C' ? 'success' : 'removed'}>{`${g}: ${s.grades[g]}`}</Lozenge>
          ))}
        </Inline>
      </Stack>
      <Stack space="space.100">
        <Heading size="small">Teams that could use support</Heading>
        {s.needSupport.length ? (
          <List type="unordered">
            {s.needSupport.map((t) => (
              <ListItem key={t.name}>
                <Text>{`${t.name}: D or E for ${t.weeks} weeks in a row`}</Text>
              </ListItem>
            ))}
          </List>
        ) : (
          <Text>No team has been at D or E for two weeks in a row.</Text>
        )}
      </Stack>
      {s.mostImproved && (
        <SectionMessage title="Most improved" appearance="success">
          <Text>{`${s.mostImproved.name} lifted its working conditions by ${s.mostImproved.rise} points against its own earlier weeks.`}</Text>
        </SectionMessage>
      )}
    </Stack>
  );
}

function CostEstimator({ strainedPeople }) {
  const [inputs, setInputs] = useState({ salary: '', replacementCostShare: '', extraTurnover: '', absenceDays: '', workingDays: '220' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const field = (name) => (e) => setInputs({ ...inputs, [name]: e.target.value });
  const run = async () => {
    try {
      setError(null);
      setResult(await invoke('estimateCost', { inputs }));
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Stack space="space.150">
      <Heading size="small">What strain may be costing (your assumptions)</Heading>
      <Text>{`${strainedPeople} people work in teams graded D or E this week. Everything else below is your own estimate.`}</Text>
      <Label labelFor="hc-salary">Average annual salary cost per person</Label>
      <Textfield id="hc-salary" type="number" value={inputs.salary} onChange={field('salary')} />
      <Label labelFor="hc-repl">Cost of replacing one person, as a share of a year’s salary (e.g. 0.5)</Label>
      <Textfield id="hc-repl" type="number" value={inputs.replacementCostShare} onChange={field('replacementCostShare')} />
      <Label labelFor="hc-turn">Extra yearly turnover you attribute to strain, as a share (e.g. 0.05)</Label>
      <Textfield id="hc-turn" type="number" value={inputs.extraTurnover} onChange={field('extraTurnover')} />
      <Label labelFor="hc-abs">Extra absence days per person per year you attribute to strain</Label>
      <Textfield id="hc-abs" type="number" value={inputs.absenceDays} onChange={field('absenceDays')} />
      <Label labelFor="hc-days">Working days per year</Label>
      <Textfield id="hc-days" type="number" value={inputs.workingDays} onChange={field('workingDays')} />
      <Inline space="space.100">
        <Button onClick={run}>Calculate</Button>
      </Inline>
      {error && (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      {result && (
        <SectionMessage title={`About ${result.total.toLocaleString()} a year`} appearance="information">
          <Stack space="space.050">
            {result.formula.map((f) => (
              <Text key={f}>{f}</Text>
            ))}
            <Text>{result.caveat}</Text>
          </Stack>
        </SectionMessage>
      )}
    </Stack>
  );
}

function Access({ settings, onSaved }) {
  const [groups, setGroups] = useState((settings?.groups || []).join('\n'));
  const [message, setMessage] = useState(null);
  const save = async () => {
    try {
      await invoke('saveOrgSettings', { settings: { groups } });
      setMessage({ appearance: 'success', text: 'Saved.' });
      await onSaved();
    } catch (err) {
      setMessage({ appearance: 'error', text: err.message });
    }
  };
  return (
    <Stack space="space.150">
      <Heading size="small">Who can see this page</Heading>
      <Text>Site administrators always can. Add the groups for HR, health and safety or leadership, one per line.</Text>
      <Label labelFor="hc-groups">Groups</Label>
      <TextArea id="hc-groups" value={groups} onChange={(e) => setGroups(e.target.value)} />
      <Inline space="space.100">
        <Button appearance="primary" onClick={save}>
          Save
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
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const load = () => invoke('organisationView').then(setView).catch((err) => setError(err.message));
  useEffect(() => {
    load();
  }, []);
  if (error) {
    return (
      <SectionMessage title="The organisation view could not load" appearance="warning">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!view) return <Text>Loading…</Text>;
  return (
    <Stack space="space.400">
      <Heading size="large">Working conditions across teams</Heading>
      <Summary s={view.summary} />
      <Stack space="space.050">
        {view.notes.map((n) => (
          <Text key={n}>{n}</Text>
        ))}
      </Stack>
      <CostEstimator strainedPeople={view.summary.strainedPeople} />
      {view.canConfigure && <Access settings={view.orgSettings} onSaved={load} />}
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
