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

const parsed = envSchema.safeParse(process.env);

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
