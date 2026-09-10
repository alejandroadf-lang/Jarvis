// Shown while a non-streaming team turn is in flight. These runs fan out
// across several agents and can take a minute, so the wait needs to look
// like work rather than a dead screen.
function Working({ label }) {
  return (
    <span className="inline-flex items-center gap-2 text-cyan-400/70">
      <span className="flex gap-1" aria-hidden="true">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="w-1.5 h-1.5 rounded-full bg-cyan-400/70 animate-pulse motion-reduce:animate-none"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      {label}
    </span>
  );
}

export default function MessageBubble({ role, content, trace, pending, pendingLabel }) {
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
          aria-live={pending ? 'polite' : undefined}
        >
          {pending ? <Working label={pendingLabel || 'Working…'} /> : content}
        </div>
      </div>
    </div>
  );
}
