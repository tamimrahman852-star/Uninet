import { useAuthStore } from '@/store/authStore';
import { API_URL } from './config';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Raw body (e.g. an ArrayBuffer chunk); overrides `body`. */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Send the access token (default true). */
  auth?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: ApiOptions['query']): string {
  const url = new URL(`${API_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function send(path: string, options: ApiOptions, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  return fetch(buildUrl(path, options.query), { method: options.method ?? 'GET', headers, body, signal: options.signal });
}

async function toError(res: Response): Promise<ApiError> {
  let code = 'error';
  let message = res.statusText || 'Request failed';
  let details: unknown;
  try {
    const data = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    code = data.error?.code ?? code;
    message = data.error?.message ?? message;
    details = data.error?.details;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, code, message, details);
}

/** Fetch JSON from the API gateway with automatic token refresh on 401. */
export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const useAuth = options.auth !== false;
  let token = useAuth ? await useAuthStore.getState().getValidToken() : null;

  let res = await send(path, options, token);
  if (res.status === 401 && useAuth && token) {
    token = await useAuthStore.getState().refresh();
    if (token) res = await send(path, options, token);
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Same as apiFetch but returns the raw Response (for SSE streams). Errors are thrown as ApiError. */
export async function apiStream(path: string, options: ApiOptions = {}): Promise<Response> {
  const opts: ApiOptions = { ...options, headers: { Accept: 'text/event-stream', ...options.headers } };
  let token = await useAuthStore.getState().getValidToken();
  let res = await send(path, opts, token);
  if (res.status === 401 && token) {
    token = await useAuthStore.getState().refresh();
    if (token) res = await send(path, opts, token);
  }
  if (!res.ok) throw await toError(res);
  return res;
}
