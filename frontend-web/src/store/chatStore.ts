'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { SocketStatus } from '@/utils/chatSocket';

export type MessageStatus = 'sending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';

export interface ChatMessage {
  id: string;
  peerId: string;
  mine: boolean;
  text: string;
  ts: number;
  status: MessageStatus;
  /** Signature check of the sender: true ok, false invalid, null unknown. */
  verified?: boolean | null;
}

export interface Peer {
  id: string;
  username?: string | null;
  fullName?: string | null;
  avatarUrl?: string | null;
  lastTs?: number;
  unread: number;
  online?: boolean;
  typing?: boolean;
}

const MAX_MESSAGES_PER_PEER = 300;

interface ChatState {
  status: SocketStatus;
  peers: Record<string, Peer>;
  messages: Record<string, ChatMessage[]>;
  activePeerId: string | null;

  setStatus: (status: SocketStatus) => void;
  setActivePeer: (peerId: string | null) => void;
  upsertPeer: (peer: Partial<Peer> & { id: string }) => void;
  addMessage: (message: ChatMessage) => void;
  updateMessage: (peerId: string, id: string, patch: Partial<ChatMessage>) => void;
  setTyping: (peerId: string, typing: boolean) => void;
  markRead: (peerId: string) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      status: 'idle',
      peers: {},
      messages: {},
      activePeerId: null,

      setStatus: (status) => set({ status }),
      setActivePeer: (activePeerId) => set({ activePeerId }),

      upsertPeer: (peer) =>
        set((state) => {
          const existing: Peer = state.peers[peer.id] ?? { id: peer.id, unread: 0 };
          return { peers: { ...state.peers, [peer.id]: { ...existing, ...peer } } };
        }),

      addMessage: (message) =>
        set((state) => {
          const list = state.messages[message.peerId] ?? [];
          if (list.some((m) => m.id === message.id)) return state;
          const next = [...list, message].sort((a, b) => a.ts - b.ts).slice(-MAX_MESSAGES_PER_PEER);
          const existing = state.peers[message.peerId] ?? { id: message.peerId, unread: 0 };
          const isActive = state.activePeerId === message.peerId;
          return {
            messages: { ...state.messages, [message.peerId]: next },
            peers: {
              ...state.peers,
              [message.peerId]: {
                ...existing,
                lastTs: Math.max(existing.lastTs ?? 0, message.ts),
                unread: message.mine || isActive ? existing.unread : existing.unread + 1,
              },
            },
          };
        }),

      updateMessage: (peerId, id, patch) =>
        set((state) => ({
          messages: {
            ...state.messages,
            [peerId]: (state.messages[peerId] ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
          },
        })),

      setTyping: (peerId, typing) =>
        set((state) => {
          const peer = state.peers[peerId];
          if (!peer) return state;
          return { peers: { ...state.peers, [peerId]: { ...peer, typing } } };
        }),

      markRead: (peerId) =>
        set((state) => {
          const peer = state.peers[peerId];
          if (!peer || peer.unread === 0) return state;
          return { peers: { ...state.peers, [peerId]: { ...peer, unread: 0 } } };
        }),

      reset: () => set({ status: 'idle', peers: {}, messages: {}, activePeerId: null }),
    }),
    {
      name: 'uninet-chat',
      storage: createJSONStorage(() => localStorage),
      // Plaintext history is kept on this device only (the server stores ciphertext). Clear it on logout.
      partialize: (state) => ({ peers: state.peers, messages: state.messages }),
    },
  ),
);
