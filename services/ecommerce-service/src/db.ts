import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './config';

/** Service-role client (bypasses RLS). Every query must filter by the authenticated user where relevant. */
export const db: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
