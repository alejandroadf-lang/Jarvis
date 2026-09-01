import axios from 'axios';

export async function sendMessage(sessionId, message) {
  const { data } = await axios.post('/api/chat', { sessionId, message });
  return data.reply;
}

export async function resetConversation(sessionId) {
  await axios.post('/api/reset', { sessionId });
}
