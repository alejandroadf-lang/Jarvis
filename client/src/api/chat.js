import axios from 'axios';

// The access token, kept in this browser only.
//
// One shared secret rather than accounts, because there is one user. It is
// held in localStorage, which means anyone with the device has it — true of a
// logged-in session too, and the honest trade for an app the founder opens on
// their phone between other things.
//
// The prompt on a 401 is deliberately plain. A styled login screen would be
// nicer and would also be the only thing standing between the founder and
// their company at the moment they most want in; this cannot fail to render.
const TOKEN_KEY = 'jarvis.accessToken';

export function getAccessToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    // Private windows and blocked site data both throw here.
    return '';
  }
}

export function setAccessToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to do — the header below still carries it for this page load */
  }
}

// Sent on every request rather than attached per call, so a new endpoint is
// authenticated by existing.
axios.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Ask once, retry once. Looping on a wrong token would lock the page into a
// prompt the founder cannot dismiss.
axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error?.config;
    if (error?.response?.status !== 401 || !config || config.__askedForToken) {
      return Promise.reject(error);
    }
    config.__askedForToken = true;
    const token = window.prompt('Access token for this app (set as APP_ACCESS_TOKEN):');
    if (!token) return Promise.reject(error);
    setAccessToken(token.trim());
    config.headers.Authorization = `Bearer ${token.trim()}`;
    return axios(config);
  }
);

/** For fetch() calls, which do not go through the interceptors above. */
export function authHeaders(base = {}) {
  const token = getAccessToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

// Streams the reply as it's generated. `onChunk(delta, fullTextSoFar)` fires
// for each piece of text received; the returned promise resolves with the
// complete reply once the stream ends.
export async function sendMessage(sessionId, message, onChunk) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
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

// Which optional integrations are actually live. The OpenRouter and Honcho
// entries are real probes server-side, so this is slower than a plain read —
// worth it, since both fail silently and this is the only place a bad key
// becomes visible without reading deploy logs.
export async function fetchIntegrations() {
  const { data } = await axios.get('/api/integrations');
  return data;
}

// What the WhatsApp webhook has actually seen. An empty list is a diagnosis
// in itself: Meta isn't calling the webhook at all.
export async function fetchWhatsAppActivity() {
  const { data } = await axios.get('/api/whatsapp/recent');
  return data; // { events, receipts }
}

// The day's plan and the founder's one decision on it.
export async function fetchDailyPlan() {
  const { data } = await axios.get('/api/plan');
  return data; // { required, plan, history }
}

export async function approveDailyPlan(note) {
  const { data } = await axios.post('/api/plan/approve', { note });
  return data;
}

export async function rejectDailyPlan(reason) {
  const { data } = await axios.post('/api/plan/reject', { reason });
  return data;
}

// Who has earned what, plus the contribution events behind each balance so
// any figure can be audited rather than taken on trust.
export async function fetchProfitShare() {
  const { data } = await axios.get('/api/profit-share');
  return data; // { net, sharePct, poolUsd, totalWeight, agents, contributions }
}

export async function fetchBuild(ventureId) {
  const { data } = await axios.get(`/api/ventures/${ventureId}/build`);
  return data; // { venture, tasks, deployments, runs, notes, milestones, spend, degradation }
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
