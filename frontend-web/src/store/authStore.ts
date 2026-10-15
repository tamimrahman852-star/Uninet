'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { API_URL } from '@/utils/config';

export interface PublicUser {
  id: string;
  email: string | null;
  email_confirmed: boolean;
  role: string;
  created_at: string;
  user_metadata: Record<string, unknown>;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number | null; // unix seconds
  user: PublicUser;
}

export interface Profile {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  bio: string | null;
}

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<boolean>;
  register: (input: { email: string; password: string; full_name?: string; username?: string }) => Promise<{ ok: boolean; needsConfirmation: boolean }>;
  sendOtp: (email: string) => Promise<boolean>;
  verifyOtp: (email: string, token: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refresh: () => Promise<string | null>;
  getValidToken: () => Promise<string | null>;
  loadProfile: () => Promise<void>;
  clearError: () => void;
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: { path: string; message: string }[] };
}

async function postJson<T>(path: string, body: unknown, token?: string): Promise<{ ok: boolean; status: number; data: T & ErrorBody }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as T & ErrorBody;
  return { ok: res.ok, status: res.status, data };
}

function errorMessage(data: ErrorBody, fallback: string): string {
  const detail = data.error?.details?.[0]?.message;
  return detail ?? data.error?.message ?? fallback;
}

let refreshInFlight: Promise<string | null> | null = null;

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      session: null,
      profile: null,
      hydrated: false,
      loading: false,
      error: null,

      clearError: () => set({ error: null }),

      login: async (email, password) => {
        set({ loading: true, error: null });
        try {
          const { ok, data } = await postJson<{ session: Session }>('/api/v1/auth/login', { email, password });
          if (!ok) {
            set({ loading: false, error: errorMessage(data, 'Login failed') });
            return false;
          }
          set({ session: data.session, loading: false });
          void get().loadProfile();
          return true;
        } catch {
          set({ loading: false, error: 'Network error, please try again' });
          return false;
        }
      },

      register: async (input) => {
        set({ loading: true, error: null });
        try {
          const { ok, data } = await postJson<{ session: Session | null; requires_email_confirmation: boolean }>('/api/v1/auth/register', input);
          if (!ok) {
            set({ loading: false, error: errorMessage(data, 'Registration failed') });
            return { ok: false, needsConfirmation: false };
          }
          if (data.session) {
            set({ session: data.session, loading: false });
            void get().loadProfile();
          } else {
            set({ loading: false });
          }
          return { ok: true, needsConfirmation: data.requires_email_confirmation };
        } catch {
          set({ loading: false, error: 'Network error, please try again' });
          return { ok: false, needsConfirmation: false };
        }
      },

      sendOtp: async (email) => {
        set({ loading: true, error: null });
        try {
          const { ok, data } = await postJson<object>('/api/v1/auth/otp/send', { email });
          set({ loading: false, error: ok ? null : errorMessage(data, 'Could not send the code') });
          return ok;
        } catch {
          set({ loading: false, error: 'Network error, please try again' });
          return false;
        }
      },

      verifyOtp: async (email, token) => {
        set({ loading: true, error: null });
        try {
          const { ok, data } = await postJson<{ session: Session }>('/api/v1/auth/otp/verify', { email, token });
          if (!ok) {
            set({ loading: false, error: errorMessage(data, 'Invalid code') });
            return false;
          }
          set({ session: data.session, loading: false });
          void get().loadProfile();
          return true;
        } catch {
          set({ loading: false, error: 'Network error, please try again' });
          return false;
        }
      },

      logout: async () => {
        const token = get().session?.access_token;
        set({ session: null, profile: null, error: null });
        if (token) {
          try {
            await postJson('/api/v1/auth/logout', { scope: 'local' }, token);
          } catch {
            /* the local session is already cleared */
          }
        }
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem('uninet-chat');
        }
      },

      refresh: async () => {
        if (refreshInFlight) return refreshInFlight;
        const refreshToken = get().session?.refresh_token;
        if (!refreshToken) return null;
        refreshInFlight = (async () => {
          try {
            const { ok, data } = await postJson<{ session: Session }>('/api/v1/auth/refresh', { refresh_token: refreshToken });
            if (!ok) {
              set({ session: null, profile: null });
              return null;
            }
            set({ session: data.session });
            return data.session.access_token;
          } catch {
            return get().session?.access_token ?? null; // network blip: keep the current token
          } finally {
            refreshInFlight = null;
          }
        })();
        return refreshInFlight;
      },

      getValidToken: async () => {
        const session = get().session;
        if (!session) return null;
        const expiresAt = session.expires_at ?? 0;
        if (expiresAt - Date.now() / 1000 < 60) return get().refresh();
        return session.access_token;
      },

      loadProfile: async () => {
        const token = await get().getValidToken();
        if (!token) return;
        try {
          const res = await fetch(`${API_URL}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
          if (res.ok) {
            const data = (await res.json()) as { profile: Profile | null };
            set({ profile: data.profile });
          }
        } catch {
          /* profile is optional for rendering */
        }
      },
    }),
    {
      name: 'uninet-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ session: state.session, profile: state.profile }),
      onRehydrateStorage: () => () => {
        useAuthStore.setState({ hydrated: true });
      },
    },
  ),
);
