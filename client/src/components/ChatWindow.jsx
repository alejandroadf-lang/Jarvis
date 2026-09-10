import { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble.jsx';

export default function ChatWindow({ messages, emptyHint, pendingLabel }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-3">
      {messages.length === 0 && (
        <p className="text-center text-cyan-500/50 text-sm mt-12">
          {emptyHint || 'Say something, or type below to get started.'}
        </p>
      )}
      {messages.map((m, i) => (
        <MessageBubble
          key={i}
          role={m.role}
          content={m.content}
          trace={m.trace}
          pending={m.pending}
          pendingLabel={pendingLabel}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
