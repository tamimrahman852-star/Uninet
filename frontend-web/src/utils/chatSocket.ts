import { WS_URL } from './config';

export interface WireKeys {
  identity_key: string;
  signed_prekey: string;
  signed_prekey_signature: string;
  one_time_prekeys?: string[];
  one_time_prekey?: string;
}

export interface WireFrame {
  type: string;
  id?: string;
  from?: string;
  to?: string;
  conversation_id?: string;
  header?: string;
  ciphertext?: string;
  status?: string;
  message_id?: string;
  server_ts?: number;
  user_id?: string;
  online?: boolean;
  limit?: number;
  keys?: WireKeys;
  error?: { code: string; message: string };
}

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'closed';

interface Pending {
  resolve: (frame: WireFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ChatSocketOptions {
  getToken: () => Promise<string | null>;
  deviceId: string;
  onFrame: (frame: WireFrame) => void;
  onStatus: (status: SocketStatus) => void;
}

const REPLY_TYPES = new Set(['ack', 'keys.bundle', 'presence', 'error']);

/** WebSocket client with automatic reconnect (exponential backoff + jitter) and request/response correlation. */
export class ChatSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: ChatSocketOptions) {}

  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    this.options.onStatus('connecting');

    const token = await this.options.getToken();
    if (!token) {
      this.options.onStatus('closed');
      return;
    }
    const url = `${WS_URL}/api/v1/chat/ws?device_id=${encodeURIComponent(this.options.deviceId)}&access_token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.options.onStatus('open');
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let frame: WireFrame;
      try {
        frame = JSON.parse(event.data) as WireFrame;
      } catch {
        return;
      }
      const correlationId = frame.message_id;
      if (correlationId && REPLY_TYPES.has(frame.type)) {
        const pending = this.pending.get(correlationId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(correlationId);
          if (frame.type === 'error') pending.reject(new Error(frame.error?.code ?? 'error'));
          else pending.resolve(frame);
          return;
        }
      }
      this.options.onFrame(frame);
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.rejectAllPending(new Error('connection_closed'));
      this.options.onStatus('closed');
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose follows and handles the retry */
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempts) + Math.floor(Math.random() * 500);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.rejectAllPending(new Error('connection_closed'));
    this.ws?.close(1000, 'client closing');
    this.ws = null;
    this.options.onStatus('closed');
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(frame: WireFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  /** Sends a frame and resolves with the server reply that references its id. */
  request(frame: WireFrame, timeoutMs = 8000): Promise<WireFrame> {
    const id = frame.id ?? crypto.randomUUID();
    return new Promise<WireFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ ...frame, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('not_connected'));
      }
    });
  }
}
