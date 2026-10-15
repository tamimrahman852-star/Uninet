'use client';

import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';
import { ChatSocket, type WireFrame } from './chatSocket';
import { decryptFrom, encryptFor, ensureKeys, publicBundle, type LocalKeys, type PeerBundle } from './e2ee';
import { supabase } from './supabaseClient';

const BUNDLE_TTL_MS = 10 * 60 * 1000;

function deviceId(): string {
  const key = 'uninet-device-id';
  let id = window.localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(key, id);
  }
  return id;
}

/** Coordinates the WebSocket, E2EE keys and the chat store. A single instance per browser tab. */
class ChatClient {
  private socket: ChatSocket | null = null;
  private keys: LocalKeys | null = null;
  private userId: string | null = null;
  private readonly bundles = new Map<string, { bundle: PeerBundle; fetchedAt: number }>();
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async start(userId: string): Promise<void> {
    if (this.userId === userId && this.socket) return;
    this.stop();
    this.userId = userId;
    this.keys = await ensureKeys(userId);
    this.socket = new ChatSocket({
      getToken: () => useAuthStore.getState().getValidToken(),
      deviceId: deviceId(),
      onFrame: (frame) => void this.onFrame(frame),
      onStatus: (status) => {
        useChatStore.getState().setStatus(status);
        if (status === 'open') void this.publishKeys();
      },
    });
    await this.socket.connect();
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
    this.userId = null;
    this.keys = null;
    this.bundles.clear();
    useChatStore.getState().setStatus('idle');
  }

  private async publishKeys(): Promise<void> {
    if (!this.socket || !this.keys) return;
    try {
      await this.socket.request({ type: 'keys.publish', keys: publicBundle(this.keys) });
    } catch {
      /* retried on the next reconnect */
    }
  }

  private async getBundle(peerId: string): Promise<PeerBundle> {
    const cached = this.bundles.get(peerId);
    if (cached && Date.now() - cached.fetchedAt < BUNDLE_TTL_MS) return cached.bundle;
    if (!this.socket) throw new Error('not_connected');
    const reply = await this.socket.request({ type: 'keys.fetch', user_id: peerId });
    if (!reply.keys) throw new Error('keys_not_found');
    const bundle: PeerBundle = {
      identity_key: reply.keys.identity_key,
      signed_prekey: reply.keys.signed_prekey,
      signed_prekey_signature: reply.keys.signed_prekey_signature,
    };
    this.bundles.set(peerId, { bundle, fetchedAt: Date.now() });
    return bundle;
  }

  /** Fills in username / avatar of a peer from the public profiles table. */
  async resolvePeer(peerId: string): Promise<void> {
    const { data } = await supabase.from('profiles').select('id, username, full_name, avatar_url').eq('id', peerId).maybeSingle();
    if (data) {
      useChatStore.getState().upsertPeer({
        id: peerId,
        username: data.username as string | null,
        fullName: data.full_name as string | null,
        avatarUrl: data.avatar_url as string | null,
      });
    } else {
      useChatStore.getState().upsertPeer({ id: peerId });
    }
  }

  async sendText(peerId: string, text: string): Promise<void> {
    const store = useChatStore.getState();
    if (!this.socket || !this.keys || !this.userId) throw new Error('not_connected');
    const id = crypto.randomUUID();
    store.addMessage({ id, peerId, mine: true, text, ts: Date.now(), status: 'sending' });
    try {
      const bundle = await this.getBundle(peerId);
      const payload = await encryptFor(this.keys, this.userId, peerId, bundle, JSON.stringify({ t: text }));
      const ack = await this.socket.request({ type: 'message', id, to: peerId, header: payload.header, ciphertext: payload.ciphertext }, 10_000);
      useChatStore.getState().updateMessage(peerId, id, { status: ack.status === 'relayed' ? 'sent' : 'queued' });
    } catch (error) {
      useChatStore.getState().updateMessage(peerId, id, { status: 'failed' });
      throw error;
    }
  }

  sendTyping(peerId: string, typing: boolean): void {
    this.socket?.send({ type: 'typing', to: peerId, status: typing ? 'start' : 'stop' });
  }

  /** Requests an older page of stored ciphertext; replies arrive as message frames with status "history". */
  async loadHistory(peerId: string, before?: number): Promise<number | null> {
    if (!this.socket) return null;
    try {
      const reply = await this.socket.request({ type: 'history.fetch', user_id: peerId, server_ts: before, limit: 50 }, 15_000);
      return reply.server_ts ?? null;
    } catch {
      return null;
    }
  }

  async queryPresence(peerId: string): Promise<void> {
    if (!this.socket) return;
    try {
      const reply = await this.socket.request({ type: 'presence.query', user_id: peerId });
      useChatStore.getState().upsertPeer({ id: peerId, online: Boolean(reply.online) });
    } catch {
      /* presence is best effort */
    }
  }

  /** Clears the unread counter and tells the sender their messages were read. */
  markRead(peerId: string): void {
    const store = useChatStore.getState();
    store.markRead(peerId);
    for (const message of store.messages[peerId] ?? []) {
      if (!message.mine && message.status === 'received') {
        this.socket?.send({ type: 'receipt', to: peerId, message_id: message.id, status: 'read' });
        store.updateMessage(peerId, message.id, { status: 'read' });
      }
    }
  }

  private async onFrame(frame: WireFrame): Promise<void> {
    const store = useChatStore.getState();
    switch (frame.type) {
      case 'message':
        await this.onMessage(frame);
        break;
      case 'receipt':
        if (frame.from && frame.message_id) {
          store.updateMessage(frame.from, frame.message_id, { status: frame.status === 'read' ? 'read' : 'delivered' });
        }
        break;
      case 'typing':
        if (frame.from) this.onTyping(frame.from, frame.status === 'start');
        break;
      default:
        break;
    }
  }

  private onTyping(peerId: string, typing: boolean): void {
    const store = useChatStore.getState();
    store.setTyping(peerId, typing);
    const existing = this.typingTimers.get(peerId);
    if (existing) clearTimeout(existing);
    if (typing) {
      this.typingTimers.set(
        peerId,
        setTimeout(() => useChatStore.getState().setTyping(peerId, false), 5000),
      );
    }
  }

  private async onMessage(frame: WireFrame): Promise<void> {
    if (!frame.from || !frame.id || !frame.header || !frame.ciphertext || !this.keys || !this.userId) return;
    const store = useChatStore.getState();
    const isHistory = frame.status === 'history';
    const ts = frame.server_ts ?? Date.now();

    if (frame.from === this.userId) {
      // Our own sent message replayed from history: the ciphertext is for the recipient, so only a local copy can be shown.
      if (frame.to) {
        store.addMessage({ id: frame.id, peerId: frame.to, mine: true, text: '[Sent from another session]', ts, status: 'sent' });
      }
      return;
    }

    const peerId = frame.from;
    if (!store.peers[peerId]) {
      store.upsertPeer({ id: peerId });
      void this.resolvePeer(peerId);
    }

    let text = '[Unable to decrypt this message]';
    let verified: boolean | null = null;
    try {
      let senderIdentity: string | null = null;
      try {
        senderIdentity = (await this.getBundle(peerId)).identity_key;
      } catch {
        senderIdentity = null;
      }
      const result = await decryptFrom(this.keys, this.userId, peerId, { header: frame.header, ciphertext: frame.ciphertext }, senderIdentity);
      const parsed = JSON.parse(result.text) as { t?: string };
      text = parsed.t ?? '';
      verified = result.verified;
    } catch {
      /* keep the placeholder text */
    }

    const active = useChatStore.getState().activePeerId === peerId;
    useChatStore.getState().addMessage({ id: frame.id, peerId, mine: false, text, ts, status: active && !isHistory ? 'read' : 'received', verified });

    if (!isHistory) {
      this.socket?.send({ type: 'receipt', to: peerId, message_id: frame.id, status: active ? 'read' : 'delivered' });
    }
  }
}

export const chatClient = new ChatClient();
