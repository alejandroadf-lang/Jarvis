import axios from 'axios';

export async function sendMessage(sessionId, message) {
  const { data } = await axios.post('/api/chat', { sessionId, message });
  return data.reply;
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

export async function greenlightVenture(ventureId, sessionId) {
  const { data } = await axios.post(`/api/ventures/${ventureId}/greenlight`, { sessionId });
  return data; // { venture, ledger, companyBriefing? }
}
