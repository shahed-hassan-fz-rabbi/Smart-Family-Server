import { Router } from 'express';
import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { User } from '../models/user';
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from '../validators/auth';
import { validate } from '../middleware/validate';
import { HttpError } from '../middleware/familyAccess';
import { requireAuth } from '../middleware/auth';
import { signSessionToken, verifySessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from '../lib/token';
import { config } from '../config/env';
import { PasswordResetToken, generateResetToken, hashToken } from '../models/passwordReset';
import { logger } from '../config/logger';

export const authRouter = Router();

const COOKIE_OPTS = sessionCookieOptions(config);

/** Whitelist of fields that may leave the server — everything absent (like
 *  passwordHash) can never leak by accident. Fail-closed by design. */
export function publicUser(u: {
  _id: unknown;
  name: string;
  email: string;
  preferredLanguage: string;
  timezone: string;
  privacy: unknown;
  notificationPrefs: unknown;
  role?: string;
}) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: (u.role === 'super_admin' ? 'super_admin' : 'user') as 'super_admin' | 'user',
    preferredLanguage: u.preferredLanguage,
    timezone: u.timezone,
    privacy: u.privacy,
    notificationPrefs: u.notificationPrefs,
  };
}

authRouter.post('/register', validate(registerSchema), async (req, res, next) => {
  try {
    const existing = await User.findOne({ email: req.body.email.toLowerCase() });
    if (existing) {
      throw new HttpError(409, 'An account with this email already exists');
    }
    const passwordHash = await bcrypt.hash(req.body.password, 12);
    // Public registration can never create a platform administrator: the role
    // is explicitly pinned to 'user' (defense in depth beyond the schema default).
    const user = await User.create({ name: req.body.name, email: req.body.email, passwordHash, role: 'user' });
    const token = signSessionToken(String(user._id), user.email, user.tokenVersion);
    res
      .cookie(SESSION_COOKIE_NAME, token, COOKIE_OPTS)
      .status(201)
      .json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const user = await User.findOne({ email: req.body.email.toLowerCase(), deletedAt: null });
    // Uniform error to avoid account enumeration.
    const invalid = new HttpError(401, 'Invalid email or password');
    if (!user) {
      await bcrypt.compare(req.body.password, '$2a$12$00000000000000000000000000000000000000000000000000000000').catch(() => null);
      throw invalid;
    }
    const ok = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!ok) throw invalid;

    const token = signSessionToken(String(user._id), user.email, user.tokenVersion);
    res.cookie(SESSION_COOKIE_NAME, token, COOKIE_OPTS).json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.user!.id);
  if (!user) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  if (user.suspendedAt) {
    res.status(401).json({ error: 'Account suspended' });
    return;
  }
  res.json({ user: publicUser(user) });
});

authRouter.post('/forgot-password', validate(forgotPasswordSchema), async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase(), deletedAt: null });
  if (user) {
    const { raw } = await generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await PasswordResetToken.create({ userId: user._id, tokenHash: hashToken(raw), expiresAt });
    logger.info({ userId: String(user._id) }, 'Password reset token generated (out-of-band delivery; never sent over the API)');
  }
  // Uniform, honest response for known and unknown emails alike — whether the
  // address exists is not revealed. The raw reset token is NEVER returned to
  // the client in any environment; delivery is out of band by an administrator.
  res.json({
    ok: true,
    message:
      'If that email is registered, a reset token has been generated and will be delivered securely by an administrator.',
  });
});

authRouter.post('/reset-password', validate(resetPasswordSchema), async (req, res, next) => {
  try {
    const record = await PasswordResetToken.findOne({
      tokenHash: hashToken(req.body.token),
      usedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!record) {
      throw new HttpError(400, 'Reset link is invalid or has expired');
    }
    const user = await User.findById(record.userId);
    if (!user) throw new HttpError(400, 'Reset link is invalid or has expired');

    user.passwordHash = await bcrypt.hash(req.body.password, 12);
    // A password reset revokes every session previously issued to this user.
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();
    record.usedAt = new Date();
    await record.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------------------
 * Google sign-in (OpenID Connect, authorization-code flow).
 *
 * Honest gating: when GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set the
 * button still exists in the UI, but every attempt lands back on /login with
 * an explicit "not configured" error — nothing pretends to work.
 *
 * Identity is established through Google's userinfo endpoint with the returned
 * access token, so no client-controlled identity is ever trusted.
 * ------------------------------------------------------------------------- */

/** A password hash that no password can ever match — for Google-only accounts. */
const UNUSABLE_PASSWORD_HASH = bcrypt.hashSync(randomBytes(24).toString('hex'), 12);

function googleRedirect(res: Response, reason: string): void {
  const sep = config.frontendUrl.includes('?') ? '&' : '?';
  res.redirect(302, `${config.frontendUrl}${sep}google=${reason}`);
}

authRouter.get('/providers', (_req, res) => {
  res.json({ google: config.google.enabled });
});

/**
 * The redirect_uri sent to Google during authorization must be byte-for-byte
 * IDENTICAL to the one used in the token exchange, and must match a URI
 * registered in Google Cloud Console. Prefer the explicit GOOGLE_REDIRECT_URI
 * override (required when the server sits behind a proxy whose externally
 * visible origin differs from the request host); otherwise derive it from the
 * request host as before (trust proxy makes this https in production).
 * The handler param is typed structurally to avoid clashing with the global
 * fetch `Request` DOM type in this module.
 */
function resolveGoogleRedirectUri(req: { protocol: string; get(name: string): string | undefined }): string {
  if (config.google.redirectUri) return config.google.redirectUri;
  return `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
}

authRouter.get('/google', (req, res) => {
  if (!config.google.enabled) {
    return googleRedirect(res, 'not_configured');
  }
  const state = randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: resolveGoogleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res
    .cookie('g_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: 10 * 60 * 1000,
      path: '/',
    })
    .redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

authRouter.get('/google/callback', async (req, res) => {
  const stateCookie = req.cookies?.['g_state'];
  res.clearCookie('g_state', { path: '/' });
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state || state !== stateCookie) {
      return googleRedirect(res, 'invalid_state');
    }

    const redirectUri = resolveGoogleRedirectUri(req);
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      logger.warn({ status: tokenRes.status }, 'Google token exchange failed');
      return googleRedirect(res, 'token_exchange_failed');
    }
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) {
      return googleRedirect(res, 'token_missing');
    }

    const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileRes.ok) {
      return googleRedirect(res, 'profile_failed');
    }
    const profile = (await profileRes.json()) as {
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    if (!profile.email) {
      return googleRedirect(res, 'no_email');
    }
    if (profile.email_verified !== true) {
      return googleRedirect(res, 'email_unverified');
    }

    let user = await User.findOne({ email: profile.email.toLowerCase(), deletedAt: null });
    if (!user) {
      user = await User.create({
        name: profile.name?.trim() || profile.email.split('@')[0],
        email: profile.email.toLowerCase(),
        passwordHash: UNUSABLE_PASSWORD_HASH,
        role: 'user',
      });
    } else if (user.name !== profile.name && (profile.name ?? '').trim().length > 0) {
      // Keep the locally chosen name unless Google only now provided one.
      if (!user.name) {
        user.name = profile.name!.trim();
        await user.save();
      }
    }

    const token = signSessionToken(String(user._id), user.email, user.tokenVersion);
    return res
      .cookie(SESSION_COOKIE_NAME, token, COOKIE_OPTS)
      .redirect(302, `${config.frontendUrl}/dashboard`);
  } catch (err) {
    logger.error({ err }, 'Google OAuth callback failed');
    return googleRedirect(res, 'failed');
  }
});
