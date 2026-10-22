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
  sameSite: 'lax' as const,
  maxAge: cfg.jwt.expiresInDays * 24 * 60 * 60 * 1000,
  path: '/',
});
