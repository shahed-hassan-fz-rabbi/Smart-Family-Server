import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export interface JwtPayload {
  sub: string;
  email: string;
}

export function signSessionToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, config.jwt.secret, {
    expiresIn: `${config.jwt.expiresInDays}d`,
  });
}

export function verifySessionToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload;
    if (!payload.sub) return null;
    return { sub: String(payload.sub), email: String(payload.email ?? '') };
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
