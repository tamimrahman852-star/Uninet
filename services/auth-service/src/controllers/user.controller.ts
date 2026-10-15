import { profileUpdateSchema, toPublicUser, type AuthContext } from '../models/user.schema';
import type { SupabaseService } from '../services/supabase.service';
import { asyncHandler } from '../utils/http';

export class UserController {
  constructor(private readonly supabase: SupabaseService) {}

  me = asyncHandler(async (req, res) => {
    const auth = req.auth as AuthContext;
    const profile = await this.supabase.getProfile(auth.user.id);
    res.json({ user: toPublicUser(auth.user), profile });
  });

  updateMe = asyncHandler(async (req, res) => {
    const updates = profileUpdateSchema.parse(req.body);
    const auth = req.auth as AuthContext;
    const profile = await this.supabase.updateProfile(auth.user.id, updates);
    res.json({ profile });
  });
}
