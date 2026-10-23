/**
 * OAuth redirect-flow regression tests.
 *
 * The Google OAuth client is mocked where it must be (network): the test
 * dresses only the two downstream HTTPS calls (token exchange + userinfo) via
 * a stubbed global fetch. The authorize step is exercised for real — the
 * state cookie and the redirect_uri sent to Google must be correct and
 * identical between /google and /google/callback.
 *
 * The client/secret values below are throwaway fakes; no real credential is
 * ever loaded or printed.
 */
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

// Real-enough-shaped fake credentials for Google to accept the pre-flight
// (the provider itself is mocked; values never leave the process).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'oauth-test-secret-0123456789abcdef';
process.env.GOOGLE_CLIENT_ID = 'oauth-test-client-id.apps.example.com';
process.env.GOOGLE_CLIENT_SECRET = 'oauth-test-throwaway-secret';
// Pin the callback the way production Render deployments should:
process.env.GOOGLE_REDIRECT_URI = 'https://smart-family-server.onrender.com/api/auth/google/callback';
process.env.GEMINI_API_KEY = '';
process.env.LIVEKIT_URL = '';
process.env.LIVEKIT_API_KEY = '';
process.env.LIVEKIT_API_SECRET = '';

let mongod: MongoMemoryServer;
let app: import('express').Express;

const FRONTEND = 'http://localhost:3000'; // NODE_ENV=test → localhost is valid
const PINNED = process.env.GOOGLE_REDIRECT_URI;

/** Install a stubbed global.fetch covering token exchange + userinfo only. */
function mockGoogleBackend(profile: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      expect(init?.method).toBe('POST');
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('redirect_uri')).toBe(PINNED);
      expect(body.get('grant_type')).toBe('authorization_code');
      return new Response(JSON.stringify({ access_token: 'fake-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return new Response(JSON.stringify(profile), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('smart-family-oauth-test');
  const db = await import('../src/db/connect');
  await db.connectDatabase();
  const mod = await import('../src/app');
  app = mod.createApp();
});

afterAll(async () => {
  const db = await import('../src/db/connect');
  await db.disconnectDatabase();
  if (mongod) await mongod.stop();
  vi.unstubAllGlobals();
});

describe('Google OAuth authorize step (/api/auth/google)', () => {
  it('redirects to accounts.google.com with the PINNED redirect_uri and a state cookie', async () => {
    const res = await request(app).get('/api/auth/google').expect(302);
    const location = res.headers.location;
    expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    const params = new URLSearchParams(location.split('?')[1]);
    // Pinned GOOGLE_REDIRECT_URI beats request-host derivation — this is the
    // value that must be registered in Google Cloud Console.
    expect(params.get('redirect_uri')).toBe(PINNED);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe('openid email profile');
    const state = params.get('state');
    expect(state).toBeTruthy();
    // state is bound to an httpOnly cookie (CSRF), secure-in-prod only.
    const cookie = res.headers['set-cookie'].find((c: string) => c.startsWith('g_state='));
    expect(cookie).toBeTruthy();
  });

  it('never leaks the client secret into the authorize URL', async () => {
    const res = await request(app).get('/api/auth/google').expect(302);
    expect(res.headers.location).not.toContain(process.env.GOOGLE_CLIENT_SECRET);
  });
});

describe('Google OAuth callback (/api/auth/google/callback)', () => {
  it('completes the mocked code exchange using the SAME redirect_uri and lands on the frontend dashboard', async () => {
    mockGoogleBackend({ email: 'Rafi.Test@Example.com', email_verified: true, name: 'Rafi Test' });
    // One authorize → its state + cookie pair, used verbatim in the exchange.
    const start = await request(app).get('/api/auth/google').expect(302);
    const startParams = new URLSearchParams(start.headers.location.split('?')[1]);
    const gCookie = start.headers['set-cookie'].find((c: string) => c.startsWith('g_state='))!.split(';')[0];
    expect(gCookie).toBeTruthy();

    const res: request.Response = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'auth-code-123', state: startParams.get('state') })
      .set('Cookie', gCookie)
      .expect(302);
    expect(res.headers.location).toBe(`${FRONTEND}/dashboard`);
    // A session cookie is set — never a token in the URL.
    expect(res.headers.location).not.toContain('token=');
    expect(res.headers['set-cookie']?.some((c: string) => /expires|Max-Age/.test(c) && !c.startsWith('g_state='))).toBe(true);
  });

  it('rejects a state that does not match the cookie (CSRF) and lands on /login?google=invalid_state', async () => {
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'x', state: 'forged-state' })
      .set('Cookie', 'g_state=different')
      .expect(302);
    expect(res.headers.location).toBe(`${FRONTEND}?google=invalid_state`);
  });

  it('reports a failed token exchange honestly (mocked 400) without leaking internals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })));
    const start = await request(app).get('/api/auth/google').expect(302);
    const params = new URLSearchParams(start.headers.location.split('?')[1]);
    const cookie = start.headers['set-cookie'].find((c: string) => c.startsWith('g_state='))!.split(';')[0];
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'bad-code', state: params.get('state') })
      .set('Cookie', cookie)
      .expect(302);
    expect(res.headers.location).toBe(`${FRONTEND}?google=token_exchange_failed`);
    // The Google error body must not reach the browser URL.
    expect(res.headers.location).not.toContain('invalid_grant');
  });

  it('links an existing verified email account instead of creating a duplicate', async () => {
    mockGoogleBackend({ email: 'linked.oauth@test.dev', email_verified: true, name: 'New Google Name' });
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'linked.oauth@test.dev', name: 'Rafi', password: 'Password123' })
      .expect(201);
    const start = await request(app).get('/api/auth/google').expect(302);
    const params = new URLSearchParams(start.headers.location.split('?')[1]);
    const cookie = start.headers['set-cookie'].find((c: string) => c.startsWith('g_state='))!.split(';')[0];
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'c', state: params.get('state') })
      .set('Cookie', cookie)
      .expect(302);
    expect(res.headers.location).toBe(`${FRONTEND}/dashboard`);
  });
});

describe('production configuration validation', () => {
  it('isLocalhostishUrl flags the dangerous values only', async () => {
    const { isLocalhostishUrl } = await import('../src/config/env');
    expect(isLocalhostishUrl('http://localhost:4000/api')).toBe(true);
    expect(isLocalhostishUrl('https://127.0.0.1:4000')).toBe(true);
    expect(isLocalhostishUrl('https://[::1]:4000')).toBe(true);
    expect(isLocalhostishUrl('https://smart-family-server.onrender.com')).toBe(false);
    expect(isLocalhostishUrl('https://smart-family-client.vercel.app')).toBe(false);
    expect(isLocalhostishUrl('https://hlocahosting.com')).toBe(false); // substring ≠ host
  });
});
