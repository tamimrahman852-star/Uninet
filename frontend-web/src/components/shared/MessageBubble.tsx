import clsx from 'clsx';
import type { ChatMessage } from '@/store/chatStore';

const STATUS_LABEL: Record<ChatMessage['status'], string> = {
  sending: '⏳',
  queued: '✓',
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓',
  failed: '⚠ failed',
  received: '',
};

export function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <div className={clsx('flex', message.mine ? 'justify-end' : 'justify-start')}>
      <div
        className={clsx(
          'max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm shadow-sm',
          message.mine
            ? 'rounded-br-sm bg-brand-600 text-white'
            : 'rounded-bl-sm bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100',
        )}
      >
        {message.text}
        <div className={clsx('mt-1 flex items-center justify-end gap-1 text-[10px]', message.mine ? 'text-brand-100' : 'text-slate-400')}>
          {message.verified === false && <span title="Signature check failed">⚠ unverified</span>}
          <span>{new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          {message.mine && (
            <span className={clsx(message.status === 'read' && 'text-sky-200', message.status === 'failed' && 'text-red-200')}>
              {STATUS_LABEL[message.status]}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
