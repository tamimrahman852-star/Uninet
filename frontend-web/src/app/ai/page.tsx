'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/layouts/AppShell';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { ApiError, apiFetch, apiStream } from '@/utils/api';
import { readSSE } from '@/utils/sse';
import { timeAgo } from '@/utils/types';

interface ChatItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
  error?: boolean;
  sources?: { document_id: string; title: string; similarity: number }[];
}

interface Conversation {
  id: string;
  title: string;
  updated_at: string;
}

interface KnowledgeDoc {
  id: string;
  title: string;
  char_count: number;
  created_at: string;
}

/** Renders ``` fenced code blocks and keeps the rest as plain pre-wrapped text. */
function MessageContent({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <pre key={index} className="my-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
            <code>{part.replace(/^[a-zA-Z0-9_+-]*\n/, '')}</code>
          </pre>
        ) : (
          <span key={index} className="whitespace-pre-wrap">
            {part}
          </span>
        ),
      )}
    </>
  );
}

export default function AiPage() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [useRag, setUseRag] = useState(false);
  const [panel, setPanel] = useState<'history' | 'knowledge' | null>(null);
  const [docTitle, setDocTitle] = useState('');
  const [docText, setDocText] = useState('');
  const [docBusy, setDocBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      const data = await apiFetch<{ conversations: Conversation[] }>('/api/v1/ai/conversations', { query: { limit: 50 } });
      setConversations(data.conversations);
    } catch {
      /* history is optional */
    }
  }, []);

  const loadDocs = useCallback(async () => {
    try {
      const data = await apiFetch<{ documents: KnowledgeDoc[] }>('/api/v1/ai/documents');
      setDocs(data.documents);
    } catch {
      setDocs([]);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
    void loadDocs();
  }, [loadConversations, loadDocs]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items]);

  async function openConversation(id: string) {
    try {
      const data = await apiFetch<{ messages: { id: string; role: 'user' | 'assistant'; content: string }[] }>(`/api/v1/ai/conversations/${id}/messages`);
      setItems(data.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })));
      setConversationId(id);
      setPanel(null);
    } catch {
      setNotice('Could not open this conversation.');
    }
  }

  function newChat() {
    abortRef.current?.abort();
    setItems([]);
    setConversationId(null);
    setPanel(null);
  }

  async function send() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft('');
    setNotice(null);

    const userItem: ChatItem = { id: crypto.randomUUID(), role: 'user', content: text };
    const assistantId = crypto.randomUUID();
    const history = [...items.filter((i) => !i.error), userItem];
    setItems([...history, { id: assistantId, role: 'assistant', content: '', pending: true }]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const patch = (fn: (item: ChatItem) => ChatItem) => setItems((prev) => prev.map((i) => (i.id === assistantId ? fn(i) : i)));

    try {
      const response = await apiStream('/api/v1/ai/chat/stream', {
        method: 'POST',
        signal: controller.signal,
        body: {
          conversation_id: conversationId ?? undefined,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          use_rag: useRag,
        },
      });

      for await (const message of readSSE(response)) {
        const data = JSON.parse(message.data) as Record<string, unknown>;
        if (message.event === 'meta') {
          if (typeof data.conversation_id === 'string') setConversationId(data.conversation_id);
          const sources = data.sources as ChatItem['sources'];
          if (sources && sources.length > 0) patch((i) => ({ ...i, sources }));
        } else if (message.event === 'token') {
          const delta = String(data.delta ?? '');
          patch((i) => ({ ...i, content: i.content + delta }));
        } else if (message.event === 'error') {
          patch((i) => ({ ...i, pending: false, error: true, content: i.content || String(data.message ?? 'The response failed.') }));
        } else if (message.event === 'done') {
          patch((i) => ({ ...i, pending: false }));
        }
      }
      patch((i) => ({ ...i, pending: false }));
      void loadConversations();
    } catch (err) {
      if (controller.signal.aborted) {
        patch((i) => ({ ...i, pending: false }));
      } else {
        const message = err instanceof ApiError ? err.message : 'Could not reach the assistant.';
        patch((i) => ({ ...i, pending: false, error: true, content: i.content || message }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  async function addDocument() {
    if (!docTitle.trim() || !docText.trim()) return;
    setDocBusy(true);
    setNotice(null);
    try {
      await apiFetch('/api/v1/ai/documents', { method: 'POST', body: { title: docTitle.trim(), content: docText } });
      setDocTitle('');
      setDocText('');
      await loadDocs();
      setUseRag(true);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not add the document.');
    } finally {
      setDocBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1_000_000) {
      setNotice('Please choose a text file under 1 MB.');
      return;
    }
    setDocText(await file.text());
    if (!docTitle) setDocTitle(file.name.replace(/\.[^.]+$/, ''));
  }

  async function removeDoc(id: string) {
    await apiFetch(`/api/v1/ai/documents/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await loadDocs();
  }

  async function removeConversation(id: string) {
    await apiFetch(`/api/v1/ai/conversations/${id}`, { method: 'DELETE' }).catch(() => undefined);
    if (id === conversationId) newChat();
    await loadConversations();
  }

  return (
    <AppShell>
      <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col md:h-[calc(100vh-6rem)]">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={newChat}>
            + New chat
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'history' ? null : 'history')}>
            History
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'knowledge' ? null : 'knowledge')}>
            Knowledge base ({docs.length})
          </Button>
          <label className="ml-auto flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useRag} onChange={(e) => setUseRag(e.target.checked)} disabled={docs.length === 0} />
            Use my documents
          </label>
        </div>

        {panel === 'history' && (
          <ul className="mb-2 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {conversations.length === 0 && <li className="p-4 text-sm text-slate-500">No conversations yet.</li>}
            {conversations.map((c) => (
              <li key={c.id} className="flex items-center gap-2 border-b border-slate-100 p-2 last:border-0 dark:border-slate-800">
                <button type="button" onClick={() => void openConversation(c.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-medium">{c.title}</span>
                  <span className="text-xs text-slate-400">{timeAgo(c.updated_at)}</span>
                </button>
                <button type="button" onClick={() => void removeConversation(c.id)} className="text-xs text-red-600">
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        {panel === 'knowledge' && (
          <section className="mb-2 space-y-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
            <input
              value={docTitle}
              onChange={(e) => setDocTitle(e.target.value)}
              placeholder="Document title"
              maxLength={200}
              className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
            <textarea
              value={docText}
              onChange={(e) => setDocText(e.target.value)}
              rows={4}
              placeholder="Paste text, or choose a .txt / .md file below"
              className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input type="file" accept=".txt,.md,.csv,text/plain" onChange={(e) => void onFile(e.target.files?.[0])} className="text-xs" />
              <Button size="sm" className="ml-auto" loading={docBusy} disabled={!docTitle.trim() || !docText.trim()} onClick={() => void addDocument()}>
                Add to knowledge base
              </Button>
            </div>
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {docs.map((doc) => (
                <li key={doc.id} className="flex items-center justify-between py-1.5">
                  <span className="truncate">
                    {doc.title} <span className="text-xs text-slate-400">· {doc.char_count.toLocaleString()} chars</span>
                  </span>
                  <button type="button" onClick={() => void removeDoc(doc.id)} className="text-xs text-red-600">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex-1 space-y-4 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          {items.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-500">
              <span className="text-5xl">✨</span>
              <p className="font-medium">How can I help you today?</p>
              <p className="max-w-sm text-sm">Ask anything. Add documents to the knowledge base to get answers grounded in your own files.</p>
            </div>
          )}
          {items.map((item) => (
            <div key={item.id} className={clsx('flex', item.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={clsx(
                  'max-w-[85%] break-words rounded-2xl px-4 py-2 text-sm',
                  item.role === 'user' ? 'bg-brand-600 text-white' : 'bg-slate-100 dark:bg-slate-800',
                  item.error && 'border border-red-300 bg-red-50 text-red-700 dark:bg-red-950',
                )}
              >
                {item.content ? <MessageContent text={item.content} /> : item.pending ? <Spinner className="h-4 w-4" /> : null}
                {item.pending && item.content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-slate-500 align-middle" />}
                {item.sources && item.sources.length > 0 && (
                  <p className="mt-2 border-t border-slate-200 pt-1 text-[11px] text-slate-500 dark:border-slate-700">
                    Sources: {Array.from(new Set(item.sources.map((s) => s.title))).join(', ')}
                  </p>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {notice && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-800">{notice}</p>}

        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            maxLength={8000}
            placeholder="Message Uninet AI"
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-slate-300 bg-white p-3 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900"
          />
          {streaming ? (
            <Button variant="danger" onClick={() => abortRef.current?.abort()}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!draft.trim()}>
              Send
            </Button>
          )}
        </form>
      </div>
    </AppShell>
  );
}
