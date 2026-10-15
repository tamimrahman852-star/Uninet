import { AuthError, createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { env, logger } from '../config';
import type { ProfileRow, ProfileUpdateInput, RegisterInput } from '../models/user.schema';
import { HttpError } from '../utils/http';

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

function fromAuthError(error: AuthError): HttpError {
  const code = (error as AuthError & { code?: string }).code ?? 'auth_error';
  switch (code) {
    case 'invalid_credentials':
      return new HttpError(401, 'invalid_credentials', 'Invalid email or password');
    case 'email_not_confirmed':
      return new HttpError(403, 'email_not_confirmed', 'Please confirm your email address before signing in');
    case 'user_already_exists':
    case 'email_exists':
      return new HttpError(409, 'email_taken', 'An account with this email already exists');
    case 'weak_password':
      return new HttpError(422, 'weak_password', 'Password is too weak');
    case 'otp_expired':
    case 'invalid_otp':
      return new HttpError(401, 'invalid_otp', 'The code is invalid or has expired');
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
    case 'over_sms_send_rate_limit':
      return new HttpError(429, 'rate_limited', 'Too many requests, please try again later');
    case 'refresh_token_not_found':
    case 'refresh_token_already_used':
    case 'session_not_found':
    case 'bad_jwt':
      return new HttpError(401, 'invalid_session', 'Session is no longer valid, please sign in again');
    default: {
      const status = typeof error.status === 'number' ? error.status : 500;
      if (status >= 400 && status < 500) return new HttpError(status, code, error.message);
      logger.error({ err: error, code }, 'Unexpected Supabase auth error');
      return new HttpError(502, 'auth_provider_error', 'Authentication provider error');
    }
  }
}

/**
 * Thin wrapper around Supabase Auth + the profiles table. All Supabase specifics (and error mapping)
 * live here so controllers only deal with domain results and HttpError.
 */
export class SupabaseService {
  /** Service-role client: bypasses RLS. Always filter by the caller's user id. */
  private readonly admin: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, clientOptions);

  /** Fresh anon client per call so no session state is ever shared between users. */
  private anon(): SupabaseClient {
    return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, clientOptions);
  }

  async ping(): Promise<boolean> {
    const { error } = await this.admin.from('profiles').select('id', { head: true, count: 'estimated' }).limit(1);
    return !error;
  }

  async isUsernameTaken(username: string): Promise<boolean> {
    const { data, error } = await this.admin.from('profiles').select('id').eq('username', username).maybeSingle();
    if (error) throw new HttpError(500, 'database_error', 'Could not verify username availability');
    return data !== null;
  }

  async signUp(input: RegisterInput): Promise<{ user: User; session: Session | null }> {
    const { data, error } = await this.anon().auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        data: { full_name: input.full_name ?? null, username: input.username ?? null },
        emailRedirectTo: env.EMAIL_REDIRECT_URL,
      },
    });
    if (error) throw fromAuthError(error);
    if (!data.user) throw new HttpError(502, 'auth_provider_error', 'Signup did not return a user');
    return { user: data.user, session: data.session };
  }

  async signIn(email: string, password: string): Promise<Session> {
    const { data, error } = await this.anon().auth.signInWithPassword({ email, password });
    if (error) throw fromAuthError(error);
    if (!data.session) throw new HttpError(502, 'auth_provider_error', 'Login did not return a session');
    return data.session;
  }

  async refresh(refreshToken: string): Promise<Session> {
    const { data, error } = await this.anon().auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw fromAuthError(error);
    if (!data.session) throw new HttpError(401, 'invalid_session', 'Session is no longer valid, please sign in again');
    return data.session;
  }

  /** Validates the JWT with Supabase (signature, expiry and session revocation). */
  async getUserFromToken(token: string): Promise<User> {
    const { data, error } = await this.admin.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, 'invalid_token', 'Invalid or expired access token');
    return data.user;
  }

  async signOut(token: string, scope: 'local' | 'global' | 'others'): Promise<void> {
    const { error } = await this.admin.auth.admin.signOut(token, scope);
    if (error) throw fromAuthError(error);
  }

  /** Returns the provider error code on failure so callers can log it; never throws except on rate limits. */
  async sendPasswordRecovery(email: string): Promise<string | null> {
    const { error } = await this.anon().auth.resetPasswordForEmail(email, { redirectTo: env.PASSWORD_RESET_REDIRECT_URL });
    if (!error) return null;
    const mapped = fromAuthError(error);
    if (mapped.status === 429) throw mapped;
    return mapped.code;
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const { error } = await this.admin.auth.admin.updateUserById(userId, { password });
    if (error) throw fromAuthError(error);
  }

  async sendOtp(email: string): Promise<string | null> {
    const { error } = await this.anon().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: env.EMAIL_REDIRECT_URL },
    });
    if (!error) return null;
    const mapped = fromAuthError(error);
    if (mapped.status === 429) throw mapped;
    return mapped.code;
  }

  async verifyOtp(email: string, token: string): Promise<Session> {
    const { data, error } = await this.anon().auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw fromAuthError(error);
    if (!data.session) throw new HttpError(401, 'invalid_otp', 'The code is invalid or has expired');
    return data.session;
  }

  async getProfile(userId: string): Promise<ProfileRow | null> {
    const { data, error } = await this.admin.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) throw new HttpError(500, 'database_error', 'Could not load profile');
    return data as ProfileRow | null;
  }

  async updateProfile(userId: string, updates: ProfileUpdateInput): Promise<ProfileRow> {
    const { data, error } = await this.admin
      .from('profiles')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select('*')
      .maybeSingle();
    if (error) {
      if (error.code === '23505') throw new HttpError(409, 'username_taken', 'This username is already taken');
      logger.error({ err: error }, 'Profile update failed');
      throw new HttpError(500, 'database_error', 'Could not update profile');
    }
    if (!data) throw new HttpError(404, 'profile_not_found', 'Profile does not exist');
    return data as ProfileRow;
  }
}
