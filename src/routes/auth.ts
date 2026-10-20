import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/user';
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from '../validators/auth';
import { validate } from '../middleware/validate';
import { HttpError } from '../middleware/familyAccess';
import { requireAuth } from '../middleware/auth';
import { signSessionToken, verifySessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from '../lib/token';
import { config } from '../config/env';
import { PasswordResetToken, generateResetToken } from '../models/passwordReset';
import { logger } from '../config/logger';

export const authRouter = Router();

const COOKIE_OPTS = sessionCookieOptions(config);

function publicUser(u: {
  _id: unknown;
  name: string;
  email: string;
  preferredLanguage: string;
  timezone: string;
  privacy: unknown;
  notificationPrefs: unknown;
}) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
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
    const user = await User.create({ name: req.body.name, email: req.body.email, passwordHash });
    const token = signSessionToken(String(user._id), user.email);
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

    const token = signSessionToken(String(user._id), user.email);
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
  res.json({ user: publicUser(user) });
});

authRouter.post('/forgot-password', validate(forgotPasswordSchema), async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase(), deletedAt: null });
  if (!user) {
    // Do not reveal whether the email exists.
    res.json({ ok: true, message: 'If that email is registered, a reset link has been generated.' });
    return;
  }
  const { raw } = await generateResetToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await PasswordResetToken.create({ userId: user._id, tokenHash: raw, expiresAt });

  // Email sending is NOT implemented. The token must be delivered out-of-band.
  const devToken = config.env === 'production' ? undefined : raw;
  logger.info({ userId: String(user._id) }, 'Password reset token generated (delivery out of band)');
  res.json({
    ok: true,
    message:
      'Email delivery is not configured on this server. Contact the family owner or admin to receive your reset token securely.' +
      (devToken ? '' : ''),
    ...(devToken ? { devToken } : {}),
  });
});

authRouter.post('/reset-password', validate(resetPasswordSchema), async (req, res, next) => {
  try {
    const record = await PasswordResetToken.findOne({
      tokenHash: req.body.token,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!record) {
      throw new HttpError(400, 'Reset link is invalid or has expired');
    }
    const user = await User.findById(record.userId);
    if (!user) throw new HttpError(400, 'Reset link is invalid or has expired');

    user.passwordHash = await bcrypt.hash(req.body.password, 12);
    await user.save();
    record.usedAt = new Date();
    await record.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
