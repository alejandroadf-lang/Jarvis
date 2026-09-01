export default function MessageBubble({ role, content }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-cyan-600 text-white rounded-br-sm'
            : 'bg-white/5 text-cyan-50 border border-cyan-500/20 rounded-bl-sm'
        }`}
      >
        {content}
      </div>
    </div>
  );
}
