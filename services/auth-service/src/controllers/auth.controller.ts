import type { Request, RequestHandler } from 'express';
import {
  forgotSchema,
  loginSchema,
  logoutSchema,
  otpSendSchema,
  otpVerifySchema,
  refreshSchema,
  registerSchema,
  resetSchema,
  toPublicSession,
  toPublicUser,
  type AuthContext,
} from '../models/user.schema';
import type { SupabaseService } from '../services/supabase.service';
import { asyncHandler, HttpError } from '../utils/http';

function bearerToken(req: Request): string {
  const header = req.headers.authorization;
  if (!header || !/^bearer\s+\S+/i.test(header)) throw new HttpError(401, 'unauthorized', 'Missing bearer token');
  return header.replace(/^bearer\s+/i, '').trim();
}

export function createRequireAuth(supabase: SupabaseService): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const token = bearerToken(req);
    const user = await supabase.getUserFromToken(token);
    req.auth = { user, token };
    next();
  });
}

export class AuthController {
  constructor(private readonly supabase: SupabaseService) {}

  register = asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    if (body.username && (await this.supabase.isUsernameTaken(body.username))) {
      throw new HttpError(409, 'username_taken', 'This username is already taken');
    }
    const { user, session } = await this.supabase.signUp(body);
    res.status(201).json({
      user: toPublicUser(user),
      session: session ? toPublicSession(session) : null,
      requires_email_confirmation: session === null,
    });
  });

  login = asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const session = await this.supabase.signIn(email, password);
    res.json({ session: toPublicSession(session) });
  });

  refresh = asyncHandler(async (req, res) => {
    const { refresh_token } = refreshSchema.parse(req.body);
    const session = await this.supabase.refresh(refresh_token);
    res.json({ session: toPublicSession(session) });
  });

  logout = asyncHandler(async (req, res) => {
    const { scope } = logoutSchema.parse(req.body ?? {});
    const auth = req.auth as AuthContext;
    await this.supabase.signOut(auth.token, scope);
    res.status(204).end();
  });

  forgotPassword = asyncHandler(async (req, res) => {
    const { email } = forgotSchema.parse(req.body);
    const failure = await this.supabase.sendPasswordRecovery(email);
    // Never reveal whether the account exists; only log for operators.
    if (failure) req.log.warn({ code: failure }, 'password recovery email failed');
    res.status(202).json({ message: 'If an account exists for this email, a recovery link has been sent' });
  });

  resetPassword = asyncHandler(async (req, res) => {
    const { password } = resetSchema.parse(req.body);
    const auth = req.auth as AuthContext;
    await this.supabase.setPassword(auth.user.id, password);
    try {
      // Invalidate every existing session after a password change.
      await this.supabase.signOut(auth.token, 'global');
    } catch (err) {
      req.log.warn({ err }, 'Global sign-out after password reset failed');
    }
    res.json({ message: 'Password updated, please sign in again' });
  });

  sendOtp = asyncHandler(async (req, res) => {
    const { email } = otpSendSchema.parse(req.body);
    const failure = await this.supabase.sendOtp(email);
    if (failure) req.log.warn({ code: failure }, 'otp email failed');
    res.status(202).json({ message: 'If an account exists for this email, a code has been sent' });
  });

  verifyOtp = asyncHandler(async (req, res) => {
    const { email, token } = otpVerifySchema.parse(req.body);
    const session = await this.supabase.verifyOtp(email, token);
    res.json({ session: toPublicSession(session) });
  });
}
