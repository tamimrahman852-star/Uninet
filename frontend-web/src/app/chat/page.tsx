'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/layouts/AppShell';
import { MessageBubble } from '@/components/shared/MessageBubble';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/store/authStore';
import { useChatStore, type ChatMessage } from '@/store/chatStore';
import { chatClient } from '@/utils/chatClient';
import { supabase } from '@/utils/supabaseClient';
import { timeAgo } from '@/utils/types';

interface SearchResult {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
}

const EMPTY_MESSAGES: ChatMessage[] = [];

export default function ChatPage() {
  const userId = useAuthStore((s) => s.session?.user.id);
  const status = useChatStore((s) => s.status);
  const peers = useChatStore((s) => s.peers);
  const allMessages = useChatStore((s) => s.messages);
  const activePeerId = useChatStore((s) => s.activePeerId);
  const { setActivePeer, upsertPeer } = useChatStore.getState();

  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<Record<string, number | null>>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingSentAt = useRef(0);
  const typingStop = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedHistory = useRef(new Set<string>());

  useEffect(() => {
    if (userId) void chatClient.start(userId);
  }, [userId]);

  const peerList = useMemo(
    () => Object.values(peers).sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0)),
    [peers],
  );
  const activePeer = activePeerId ? peers[activePeerId] : undefined;
  const messages = (activePeerId ? allMessages[activePeerId] : undefined) ?? EMPTY_MESSAGES;

  const openPeer = useCallback(
    (peerId: string) => {
      setActivePeer(peerId);
      setSendError(null);
      chatClient.markRead(peerId);
      void chatClient.queryPresence(peerId);
    },
    [setActivePeer],
  );

  useEffect(() => {
    if (!activePeerId || status !== 'open' || loadedHistory.current.has(activePeerId)) return;
    loadedHistory.current.add(activePeerId);
    const peerId = activePeerId;
    void chatClient.loadHistory(peerId).then((cursor) => setHistoryCursor((prev) => ({ ...prev, [peerId]: cursor })));
  }, [activePeerId, status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    if (activePeerId) chatClient.markRead(activePeerId);
  }, [messages.length, activePeerId]);

  async function runSearch() {
    const q = search.replace(/[%,()*]/g, ' ').trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const { data } = await supabase
      .from('profiles')
      .select('id, username, full_name, avatar_url')
      .or(`username.ilike.%${q}%,full_name.ilike.%${q}%`)
      .neq('id', userId ?? '')
      .limit(8);
    setResults((data ?? []) as SearchResult[]);
  }

  function startChat(result: SearchResult) {
    upsertPeer({ id: result.id, username: result.username, fullName: result.full_name, avatarUrl: result.avatar_url });
    setResults([]);
    setSearch('');
    openPeer(result.id);
  }

  async function send() {
    const text = draft.trim();
    if (!text || !activePeerId) return;
    setDraft('');
    setSendError(null);
    if (typingStop.current) clearTimeout(typingStop.current);
    chatClient.sendTyping(activePeerId, false);
    try {
      await chatClient.sendText(activePeerId, text);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setSendError(
        code === 'keys_not_found'
          ? 'This user has not set up encrypted chat yet (they need to open Chat once).'
          : 'Message could not be sent. Check your connection and try again.',
      );
    }
  }

  function onTyping(value: string) {
    setDraft(value);
    if (!activePeerId) return;
    const now = Date.now();
    if (now - typingSentAt.current > 3000) {
      typingSentAt.current = now;
      chatClient.sendTyping(activePeerId, true);
    }
    if (typingStop.current) clearTimeout(typingStop.current);
    typingStop.current = setTimeout(() => chatClient.sendTyping(activePeerId, false), 2000);
  }

  async function loadOlder() {
    if (!activePeerId) return;
    const cursor = historyCursor[activePeerId];
    if (!cursor) return;
    setLoadingOlder(true);
    const next = await chatClient.loadHistory(activePeerId, cursor);
    setHistoryCursor((prev) => ({ ...prev, [activePeerId]: next && next !== cursor ? next : null }));
    setLoadingOlder(false);
  }

  const peerName = (peer?: { fullName?: string | null; username?: string | null; id: string }) =>
    peer?.fullName || (peer?.username ? `@${peer.username}` : peer ? `User ${peer.id.slice(0, 6)}` : '');

  return (
    <AppShell fullHeight>
      <div className="flex h-[calc(100vh-7.5rem)] overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 md:h-[calc(100vh-5.5rem)]">
        {/* conversations */}
        <aside className={clsx('flex w-full flex-col border-r border-slate-200 dark:border-slate-800 md:w-80', activePeerId && 'hidden md:flex')}>
          <div className="space-y-2 border-b border-slate-200 p-3 dark:border-slate-800">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Chats</h2>
              <span
                className={clsx(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  status === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700',
                )}
              >
                {status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Offline'}
              </span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch();
              }}
            >
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find people by name or @username"
                className="h-9 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-800"
              />
            </form>
            {results.length > 0 && (
              <ul className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
                {results.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => startChat(r)} className="flex w-full items-center gap-2 p-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800">
                      <Avatar src={r.avatar_url} name={r.full_name ?? r.username} size={32} />
                      <span className="truncate text-sm">{r.full_name ?? r.username}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <ul className="flex-1 overflow-y-auto">
            {peerList.length === 0 && <li className="p-6 text-center text-sm text-slate-500">Search for someone to start an encrypted chat.</li>}
            {peerList.map((peer) => {
              const last = (allMessages[peer.id] ?? EMPTY_MESSAGES).at(-1);
              return (
                <li key={peer.id}>
                  <button
                    type="button"
                    onClick={() => openPeer(peer.id)}
                    className={clsx(
                      'flex w-full items-center gap-3 p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800',
                      activePeerId === peer.id && 'bg-brand-50 dark:bg-brand-900/20',
                    )}
                  >
                    <Avatar src={peer.avatarUrl} name={peerName(peer)} online={peer.online} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{peerName(peer)}</span>
                        {last && <span className="shrink-0 text-[11px] text-slate-400">{timeAgo(last.ts)}</span>}
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-slate-500">{peer.typing ? 'typing…' : (last?.text ?? 'No messages yet')}</span>
                        {peer.unread > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">{peer.unread}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* conversation */}
        <section className={clsx('flex min-w-0 flex-1 flex-col', !activePeerId && 'hidden md:flex')}>
          {!activePeer ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-slate-500">
              <span className="text-5xl">🔒</span>
              <p className="font-medium">End-to-end encrypted chat</p>
              <p className="max-w-xs text-sm">Messages are encrypted on your device. Only you and the recipient can read them.</p>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-3 border-b border-slate-200 p-3 dark:border-slate-800">
                <button type="button" className="md:hidden" onClick={() => setActivePeer(null)} aria-label="Back to chats">
                  ←
                </button>
                <Avatar src={activePeer.avatarUrl} name={peerName(activePeer)} online={activePeer.online} size={36} />
                <div className="min-w-0">
                  <p className="truncate font-semibold">{peerName(activePeer)}</p>
                  <p className="text-xs text-slate-500">{activePeer.typing ? 'typing…' : activePeer.online ? 'online' : 'offline'}</p>
                </div>
              </header>

              <div className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-4 dark:bg-slate-950">
                {activePeerId && historyCursor[activePeerId] ? (
                  <div className="flex justify-center">
                    <Button variant="ghost" size="sm" loading={loadingOlder} onClick={() => void loadOlder()}>
                      Load older messages
                    </Button>
                  </div>
                ) : null}
                <p className="mx-auto max-w-xs rounded-lg bg-amber-50 p-2 text-center text-[11px] text-amber-800">
                  🔒 Messages are end-to-end encrypted. Only the devices in this chat can read them.
                </p>
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
                <div ref={bottomRef} />
              </div>

              {sendError && <p className="bg-red-50 px-4 py-2 text-xs text-red-700">{sendError}</p>}
              <form
                className="flex items-end gap-2 border-t border-slate-200 p-3 dark:border-slate-800"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  value={draft}
                  onChange={(e) => onTyping(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={1}
                  maxLength={4000}
                  placeholder="Type a message"
                  className="max-h-32 min-h-[40px] flex-1 resize-none rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-800"
                />
                <Button type="submit" disabled={!draft.trim() || status !== 'open'}>
                  Send
                </Button>
              </form>
            </>
          )}
        </section>
      </div>
    </AppShell>
  );
}
