/**
 * Request validation schemas and shared types for the auth domain.
 * The matching PostgreSQL / Supabase tables (profiles, device_sessions) live in ../../supabase/schema.sql.
 */
import type { Session, User } from '@supabase/supabase-js';
import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a digit');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,30}$/, 'Username must be 3-30 chars of a-z, 0-9 or _');

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    full_name: z.string().trim().min(1).max(120).optional(),
    username: usernameSchema.optional(),
  })
  .strict();

export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(72) }).strict();
export const refreshSchema = z.object({ refresh_token: z.string().min(10).max(2048) }).strict();
export const logoutSchema = z.object({ scope: z.enum(['local', 'global', 'others']).default('local') }).strict();
export const forgotSchema = z.object({ email: emailSchema }).strict();
export const resetSchema = z.object({ password: passwordSchema }).strict();
export const otpSendSchema = z.object({ email: emailSchema }).strict();
export const otpVerifySchema = z
  .object({ email: emailSchema, token: z.string().trim().regex(/^\d{6,8}$/, 'Invalid code') })
  .strict();

export const profileUpdateSchema = z
  .object({
    full_name: z.string().trim().min(1).max(120).optional(),
    username: usernameSchema.optional(),
    avatar_url: z.string().url().max(2048).nullable().optional(),
    bio: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

/** Row shape of public.profiles */
export interface ProfileRow {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthContext {
  user: User;
  token: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function toPublicUser(user: User) {
  const appRole = (user.app_metadata as { role?: unknown } | undefined)?.role;
  return {
    id: user.id,
    email: user.email ?? null,
    email_confirmed: Boolean(user.email_confirmed_at),
    role: typeof appRole === 'string' ? appRole : 'user',
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at ?? null,
    user_metadata: user.user_metadata ?? {},
  };
}

export function toPublicSession(session: Session) {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: session.token_type,
    expires_in: session.expires_in,
    expires_at: session.expires_at ?? null,
    user: toPublicUser(session.user),
  };
}
