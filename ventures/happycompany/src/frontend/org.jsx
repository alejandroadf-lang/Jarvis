// The organisation view: coverage, how many teams work in sustainable
// conditions, recovery, action, and who could use support. Never a ranking.
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  CodeBlock,
  Heading,
  Inline,
  Label,
  List,
  ListItem,
  Lozenge,
  SectionMessage,
  Select,
  Stack,
  Text,
  TextArea,
  Textfield,
  Toggle,
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
      {s.validation && (
        <Stack space="space.100">
          <Heading size="small">Does the grade track reported burnout?</Heading>
          <Text>{s.validation.rho === null ? s.validation.verdict : `Across ${s.validation.teams} teams: rank correlation ${s.validation.rho}. ${s.validation.verdict}`}</Text>
          {s.validation.matchMean !== null && <Text>{`Teams rate "the grade matches how the weeks felt" at ${s.validation.matchMean} of 5 on average.`}</Text>}
          <Text>Teams join the check by switching on validation mode in their pulse settings.</Text>
        </Stack>
      )}
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

const ATTENTION = { high: 'removed', medium: 'moved', low: 'success', 'no data': 'default' };

function Level({ level }) {
  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Heading size="small">{`Level for ${level.quarter}: ${level.label}`}</Heading>
      </Inline>
      <List type="unordered">
        {level.criteria.map((c) => (
          <ListItem key={c.key}>
            <Inline space="space.100" shouldWrap>
              <Lozenge appearance={c.met ? 'success' : 'default'}>{c.met ? 'met' : 'not yet'}</Lozenge>
              <Text>{`${c.text}: ${c.value}`}</Text>
            </Inline>
          </ListItem>
        ))}
      </List>
      {level.next && <Text>{`For ${level.next.label}: ${level.next.missing.join('; ')}.`}</Text>}
      <Text>Measuring, Acting and Sustaining are Happy Company’s own levels, with provisional thresholds. They are not an ISO certification; ISO 45003 is guidance and only an accredited body certifies an ISO 45001 management system.</Text>
    </Stack>
  );
}

function EvidenceSettings({ settings, onSaved }) {
  const [form, setForm] = useState({
    consultationRecorded: Boolean(settings?.consultationRecorded),
    consultationDate: settings?.consultationDate || '',
    organisationName: settings?.organisationName || '',
    evidenceSpaceId: settings?.evidenceSpaceId || '',
  });
  const [message, setMessage] = useState(null);
  const field = (name) => (e) => setForm({ ...form, [name]: e.target.value });
  const save = async () => {
    try {
      await invoke('saveOrgSettings', { settings: form });
      setMessage({ appearance: 'success', text: 'Saved. The next evidence pack uses these.' });
      await onSaved();
    } catch (err) {
      setMessage({ appearance: 'error', text: err.message });
    }
  };
  return (
    <Stack space="space.150">
      <Heading size="xsmall">Evidence settings</Heading>
      <Toggle
        id="hc-consulted"
        label="Workers’ representatives (works council, health and safety committee or employee representatives) were consulted on this app"
        isChecked={form.consultationRecorded}
        onChange={(e) => setForm({ ...form, consultationRecorded: Boolean(e.target.checked) })}
      />
      <Label labelFor="hc-consulted-on">Date of that consultation (YYYY-MM-DD)</Label>
      <Textfield id="hc-consulted-on" value={form.consultationDate} onChange={field('consultationDate')} />
      <Label labelFor="hc-orgname">Organisation name printed on packs and attestations</Label>
      <Textfield id="hc-orgname" value={form.organisationName} onChange={field('organisationName')} />
      <Label labelFor="hc-space">Confluence space id to publish evidence pages to (digits; leave empty to not publish)</Label>
      <Textfield id="hc-space" value={form.evidenceSpaceId} onChange={field('evidenceSpaceId')} />
      <Inline space="space.100">
        <Button onClick={save}>Save evidence settings</Button>
      </Inline>
      {message && (
        <SectionMessage appearance={message.appearance}>
          <Text>{message.text}</Text>
        </SectionMessage>
      )}
    </Stack>
  );
}

// The quarterly psychosocial-risk evidence pack, its level, drafts for
// disclosures, and (for administrators) the signed attestation.
function Evidence({ canConfigure, orgSettings, onSaved }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const load = (quarter) =>
    invoke('evidenceView', quarter ? { quarter } : {})
      .then((v) => {
        setError(null);
        setView(v);
      })
      .catch((err) => setError(err.message));
  useEffect(() => {
    load();
  }, []);
  const act = (name, success) => async () => {
    try {
      const r = await invoke(name, { quarter: view.quarter });
      setMessage({ appearance: 'success', text: success(r) });
      await load(view.quarter);
    } catch (err) {
      setMessage({ appearance: 'error', text: err.message });
    }
  };
  if (error) {
    return (
      <SectionMessage title="The evidence pack could not load" appearance="warning">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!view) return <Text>Building the evidence pack…</Text>;
  const p = view.pack;
  return (
    <Stack space="space.300">
      <Heading size="medium">Psychosocial risk evidence (ISO 45003-aligned)</Heading>
      <Label labelFor="hc-quarter">Quarter</Label>
      <Select
        inputId="hc-quarter"
        options={view.quarters.map((q) => ({ label: q, value: q }))}
        value={{ label: view.quarter, value: view.quarter }}
        onChange={(option) => option && load(option.value)}
      />
      {view.live && (
        <SectionMessage appearance="information">
          <Text>This quarter is still running: this is a draft. The closed quarter is packed in its first weeks and kept for three years.</Text>
        </SectionMessage>
      )}
      <Level level={view.level} />
      <Stack space="space.100">
        <Heading size="small">Hazards screened</Heading>
        <Text>{`${p.scope.teams} teams, ${p.scope.teamWeeks} team-weeks. Share of team-weeks at "act now", and the trend within the quarter.`}</Text>
        <List type="unordered">
          {p.hazards.slice(0, 10).map((h) => (
            <ListItem key={h.key}>
              <Inline space="space.100" shouldWrap>
                <Lozenge appearance={ATTENTION[h.attention]}>{h.attention}</Lozenge>
                <Text>{`${h.label}: ${pct(h.actShare)} of team-weeks, ${h.direction}`}</Text>
              </Inline>
            </ListItem>
          ))}
        </List>
        <Text>{`Actions: ${p.actions.teams} teams committed to ${p.actions.committed} changes; ${pct(p.actions.completion)} of closed actions done. Pulse: ${p.participation.pulseTeams} teams, ${p.participation.responses} responses.`}</Text>
      </Stack>
      <Stack space="space.100">
        <Heading size="small">The full pack</Heading>
        <Text>Copy it into your management system, or publish it to Confluence. It maps every signal to ISO 45003, the HSE Management Standards, GDA, Safe Work Australia, the French DUERP, the Dutch RI&E, Belgian law and Japan’s stress check, and says what the app does not cover.</Text>
        <CodeBlock text={view.markdown} language="markdown" shouldWrapLongLines />
      </Stack>
      <Stack space="space.100">
        <Heading size="small">Disclosure drafts</Heading>
        {Object.entries(view.disclosures).map(([key, d]) => (
          <Stack key={key} space="space.050">
            <Heading size="xsmall">{d.title}</Heading>
            <Text>{d.text}</Text>
            <Text>{d.caveat}</Text>
          </Stack>
        ))}
      </Stack>
      {(view.canAttest || view.attestation) && (
        <Stack space="space.100">
          <Heading size="small">Signed attestation</Heading>
          <Text>A statement of this quarter’s level, signed with this installation’s key. Anyone can check it offline with scripts/verify-attestation.mjs. It is self-attested, not a certification.</Text>
          {view.key && <Text>{`This installation’s key id: ${view.key.keyId}`}</Text>}
          {view.attestation && <CodeBlock text={JSON.stringify(view.attestation, null, 2)} language="json" shouldWrapLongLines />}
          <Inline space="space.100" shouldWrap>
            {view.canAttest && <Button onClick={act('issueAttestation', (a) => `Signed: ${a.payload.levelLabel}, valid until ${a.payload.validUntil}.`)}>{view.attestation ? 'Sign again' : 'Sign attestation'}</Button>}
            {view.canPublish && !p.publishedPageId && <Button onClick={act('publishEvidence', (r) => `Published as "${r.title}".`)}>Publish to Confluence</Button>}
          </Inline>
          {p.publishedPageId && <Text>{`Published to Confluence, page ${p.publishedPageId}.`}</Text>}
        </Stack>
      )}
      {message && (
        <SectionMessage appearance={message.appearance}>
          <Text>{message.text}</Text>
        </SectionMessage>
      )}
      {canConfigure && <EvidenceSettings settings={orgSettings} onSaved={onSaved} />}
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
      <Evidence canConfigure={view.canConfigure} orgSettings={view.orgSettings} onSaved={load} />
      {view.canConfigure && <Access settings={view.orgSettings} onSaved={load} />}
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
