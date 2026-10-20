import { NextFunction, Response } from 'express';
import { AuthedRequest } from '../types/http';
import { verifySessionToken, SESSION_COOKIE_NAME } from '../lib/token';
import { User } from '../models/user';

/** Requires a valid session cookie; attaches req.user. */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token =
    (req.cookies && (req.cookies[SESSION_COOKIE_NAME] as string | undefined)) ||
    bearerToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  const user = await User.findOne({ _id: payload.sub, deletedAt: null });
  if (!user) {
    res.status(401).json({ error: 'Account not found' });
    return;
  }

  req.user = {
    id: user._id,
    email: user.email,
    name: user.name,
    preferredLanguage: user.preferredLanguage,
    timezone: user.timezone,
  };
  next();
}

function bearerToken(req: AuthedRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return undefined;
}

type FamilyRole = 'owner' | 'admin' | 'member';

/** Role hierarchy used for permission checks. */
const ROLE_RANK: Record<FamilyRole, number> = { member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: FamilyRole, min: FamilyRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
