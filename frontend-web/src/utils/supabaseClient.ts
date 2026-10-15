import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { useAuthStore } from '@/store/authStore';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';

/**
 * Supabase client used for the social feed (posts, stories) and storage uploads.
 * Sessions are owned by the auth store (login goes through the API gateway), so every request is
 * sent with the current user's access token instead of letting supabase-js manage its own session.
 */
export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: {
    fetch: async (input, init) => {
      const token = await useAuthStore.getState().getValidToken();
      const headers = new Headers(init?.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
  },
});
