import axios from 'axios';

// Streams the reply as it's generated. `onChunk(delta, fullTextSoFar)` fires
// for each piece of text received; the returned promise resolves with the
// complete reply once the stream ends.
export async function sendMessage(sessionId, message, onChunk) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });

  if (!res.ok) {
    let errorMessage = 'Failed to reach the assistant';
    try {
      const data = await res.json();
      errorMessage = data.error || errorMessage;
    } catch {
      // response wasn't JSON (e.g. a stream already started) — keep the default
    }
    throw new Error(errorMessage);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const delta = decoder.decode(value, { stream: true });
    full += delta;
    onChunk?.(delta, full);
  }

  return full;
}

export async function resetConversation(sessionId) {
  await axios.post('/api/reset', { sessionId });
}

export async function sendCompanyMessage(sessionId, message) {
  const { data } = await axios.post('/api/company/chat', { sessionId, message });
  return { reply: data.reply, trace: data.trace || [] };
}

export async function resetCompanyConversation(sessionId) {
  await axios.post('/api/company/reset', { sessionId });
}

export async function sendStudioMessage(sessionId, message) {
  const { data } = await axios.post('/api/studio/chat', { sessionId, message });
  return { reply: data.reply, trace: data.trace || [] };
}

export async function resetStudioConversation(sessionId) {
  await axios.post('/api/studio/reset', { sessionId });
}

// `kind` is 'company' or 'studio' — both expose the same org-chart shape.
export async function fetchOrgChart(kind = 'company') {
  const { data } = await axios.get(`/api/${kind}/org-chart`);
  return data;
}

export async function fetchVentures() {
  const { data } = await axios.get('/api/ventures');
  return data.ventures;
}

export async function fetchLedger() {
  const { data } = await axios.get('/api/ventures/ledger');
  return data;
}

export async function fetchPortfolio() {
  const { data } = await axios.get('/api/ventures/portfolio');
  return data; // { ventures, totals, business }
}

export async function killVenture(ventureId, reason) {
  const { data } = await axios.post(`/api/ventures/${ventureId}/kill`, { reason });
  return data; // { venture }
}

export async function linkVentureRepo(ventureId, { owner, name, branch, allowedPaths, maxPerWeek, maxPerDay }) {
  const { data } = await axios.post(`/api/ventures/${ventureId}/repo`, {
    owner,
    name,
    branch,
    allowedPaths,
    maxPerWeek,
    maxPerDay,
  });
  return data; // { venture }
}

export async function enableVentureDeployment(ventureId) {
  const { data } = await axios.post(`/api/ventures/${ventureId}/deployment/enable`);
  return data; // { venture }
}

export async function disableVentureDeployment(ventureId) {
  const { data } = await axios.post(`/api/ventures/${ventureId}/deployment/disable`);
  return data; // { venture }
}

export async function linkVentureOutreach(ventureId, { allowedRecipients, maxPerWeek, maxPerDay }) {
  const { data } = await axios.post(`/api/ventures/${ventureId}/outreach`, { allowedRecipients, maxPerWeek, maxPerDay });
  return data; // { venture }
}

export async function fetchKillSwitch() {
  const { data } = await axios.get('/api/kill-switch');
  return data; // { halted, reason, changedAt, envLocked }
}

export async function haltRealActions(reason) {
  const { data } = await axios.post('/api/kill-switch/halt', { reason });
  return data;
}

export async function resumeRealActions() {
  const { data } = await axios.post('/api/kill-switch/resume');
  return data;
}

export async function fetchSpend() {
  const { data } = await axios.get('/api/spend');
  return data; // { spentUsd, capUsd, date, overCap }
}

export async function enableVentureOutreach(ventureId) {
  const { data } = await axios.post(`/api/ventures/${ventureId}/outreach/enable`);
  return data; // { venture }
}

export async function disableVentureOutreach(ventureId) {
  const { data } = await axios.post(`/api/ventures/${ventureId}/outreach/disable`);
  return data; // { venture }
}

export async function fetchDailyReports() {
  const { data } = await axios.get('/api/reports/daily');
  return data.reports; // newest first
}

export async function fetchLatestDailyReport() {
  const { data } = await axios.get('/api/reports/daily/latest');
  return data.report; // null if none yet
}

export async function runDailyMeetingNow() {
  const { data } = await axios.post('/api/reports/daily/run');
  return data.report;
}

export async function fetchWeeklyReflections() {
  const { data } = await axios.get('/api/reports/weekly');
  return data.reflections; // newest first
}

export async function fetchLatestWeeklyReflection() {
  const { data } = await axios.get('/api/reports/weekly/latest');
  return data.reflection; // null if none yet
}

export async function runWeeklyReflectionNow() {
  const { data } = await axios.post('/api/reports/weekly/run');
  return data.reflection;
}
