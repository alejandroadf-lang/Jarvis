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

export async function fetchOrgChart() {
  const { data } = await axios.get('/api/company/org-chart');
  return data;
}
