import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export interface JwtPayload {
  sub: string;
  email: string;
  /** Session-invalidations counter of the user at signing time. */
  tv: number;
}

export function signSessionToken(userId: string, email: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, email, tv: tokenVersion }, config.jwt.secret, {
    expiresIn: `${config.jwt.expiresInDays}d`,
  });
}

export function verifySessionToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload;
    if (!payload.sub) return null;
    // Tokens signed before the tv field existed carry no claim — treated as
    // version 0 so existing sessions stay valid until they are revoked.
    return { sub: String(payload.sub), email: String(payload.email ?? ''), tv: Number(payload.tv ?? 0) };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = 'sf_token';

export const sessionCookieOptions = (cfg: typeof config) => ({
  httpOnly: true as const,
  secure: cfg.isProd,
  /**
   * In production the frontend (vercel.app) and backend (onrender.com) are
   * different registrable domains, i.e. a CROSS-SITE context: SameSite=Lax
   * cookies are never attached to the frontend's fetch() calls, so every
   * authenticated request would 401 right after a successful login. The
   * standard, non-weakening policy for a cross-origin session cookie is
   * SameSite=None with Secure (both are kept: httpOnly stays, tokens remain
   * revocable via tokenVersion, and CSRF state cookies stay Lax). Dev stays
   * Lax (localhost is a single-site context there).
   */
  sameSite: (cfg.isProd ? 'none' : 'lax') as 'none' | 'lax',
  maxAge: cfg.jwt.expiresInDays * 24 * 60 * 60 * 1000,
  path: '/',
});
