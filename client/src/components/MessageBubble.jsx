export default function MessageBubble({ role, content, trace }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] ${isUser ? '' : 'space-y-1'}`}>
        {!isUser && trace && trace.length > 0 && (
          <div className="flex flex-wrap gap-1 px-1">
            {trace.map((agent, i) => (
              <span
                key={`${agent.id}-${i}`}
                title={agent.department}
                className="text-[10px] uppercase tracking-wide text-cyan-400/70 border border-cyan-500/30 rounded-full px-2 py-0.5"
              >
                {agent.title}
              </span>
            ))}
          </div>
        )}
        <div
          className={`rounded-2xl px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
            isUser
              ? 'bg-cyan-600 text-white rounded-br-sm'
              : 'bg-white/5 text-cyan-50 border border-cyan-500/20 rounded-bl-sm'
          }`}
        >
          {content}
        </div>
      </div>
    </div>
  );
}
