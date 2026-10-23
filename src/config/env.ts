import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required (MongoDB Atlas connection string)'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z
    .string()
    .optional()
    .describe('Comma-separated list of allowed browser origins. Falls back to FRONTEND_URL.'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN_DAYS: z.coerce.number().default(30),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z
    .string()
    .optional()
    .describe('Full https callback URL registered in Google Cloud Console; defaults to <server origin>/api/auth/google/callback'),
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/** True for loopback/dev URLs that must never be used as an external address in production. */
export function isLocalhostishUrl(value: string): boolean {
  return /localhost|127\.0\.0\.1|::1|\[::1\]/i.test(value);
}

const parsed = envSchema
  .superRefine((data, ctx) => {
  // In production, silently falling back to localhost breaks OAuth redirects
  // and CORS in ways that only surface when a user clicks "Login". Fail at
  // boot with the exact fix instead.
  if (data.NODE_ENV !== 'production') return;
  const checks: Array<[string, string, string]> = [
    ['FRONTEND_URL', data.FRONTEND_URL, 'set it to your deployed frontend, e.g. https://smart-family-client.vercel.app'],
    ['GOOGLE_REDIRECT_URI', data.GOOGLE_REDIRECT_URI ?? '', 'set it to the full https callback URL registered in Google Cloud Console'],
  ];
  for (const [field, value, fix] of checks) {
    if (!value) continue; // FRONTEND_URL always has a value; GOOGLE_REDIRECT_URI is optional
    if (isLocalhostishUrl(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} points to localhost, which is unreachable in a production deployment — ${fix}`,
      });
    } else if (!value.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must start with https:// in production — ${fix}`,
      });
    }
  }
}).safeParse(process.env);

if (!parsed.success) {
  // Surface a precise startup failure instead of a runtime crash later.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

const corsOrigins = (env.CORS_ORIGINS ?? env.FRONTEND_URL)
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  port: env.PORT,
  mongoUri: env.MONGODB_URI,
  frontendUrl: env.FRONTEND_URL.replace(/\/+$/, ''),
  corsOrigins,
  jwt: {
    secret: env.JWT_SECRET,
    expiresInDays: env.JWT_EXPIRES_IN_DAYS,
  },
  gemini: {
    apiKey: env.GEMINI_API_KEY ?? '',
    model: env.GEMINI_MODEL,
    enabled: Boolean(env.GEMINI_API_KEY),
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    // Explicit callback override (GOOGLE_REDIRECT_URI) or "<request origin>" —
    // the value MUST exactly match one of the URIs registered in Google Cloud
    // Console, and must be identical in both the authorize step and the token
    // exchange step.
    redirectUri: env.GOOGLE_REDIRECT_URI ?? '',
    enabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  },
  livekit: {
    url: env.LIVEKIT_URL ?? '',
    apiKey: env.LIVEKIT_API_KEY ?? '',
    apiSecret: env.LIVEKIT_API_SECRET ?? '',
    enabled: Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET),
  },
  logLevel: env.LOG_LEVEL,
} as const;
