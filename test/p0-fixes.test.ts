/**
 * Regression tests for the three P0 production-readiness fixes:
 *
 *   Fix 1 — GET /api/calls/:id/token must await livekit's async toJwt() and
 *           return a real JWT string (not a serialized Promise / empty object).
 *   Fix 2 — PATCH /users/me (and every other user response) must never
 *           contain passwordHash or any other credential material.
 *   Fix 3 — POST /api/auth/forgot-password must NEVER return a reset token in
 *           any environment, while the secure reset workflow still works
 *           (token hashed at rest, single-use, validated by hash).
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Server as HttpServer } from 'http';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'p0-fixes-test-secret-0123456789abcdef';
// Isolate tests from any developer's real `.env`.
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
// LiveKit IS given fake credentials on purpose: JWT access-token signing is a
// purely local computation, so Fix 1 can be verified without any LiveKit
// server. Fake values never reach the network.
process.env.LIVEKIT_URL = 'wss://p0-test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'p0testkey';
process.env.LIVEKIT_API_SECRET = 'p0-test-secret-0123456789abcdef';

let mongod: MongoMemoryServer;
let app: import('express').Express;
let httpServer: HttpServer;

const OWNER = 'p0-owner@test.dev';
const CALLEE = 'p0-callee@test.dev';

async function login(email: string, password = 'Password123'): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'][0].split(';')[0];
}

async function register(email: string, name: string): Promise<void> {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'Password123' });
  if (res.status !== 201) throw new Error(`register ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
}

/** Decodes the middle segment of a JWT into its JSON payload. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  expect(parts.length).toBe(3);
  return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
}

let ownerCookie = '';
let calleeCookie = '';
let ownerId = '';
let calleeId = '';
let familyId = '';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('smart-family-p0-test');
  const db = await import('../src/db/connect');
  await db.connectDatabase();

  const mod = await import('../src/app');
  app = mod.createApp();

  const http = await import('http');
  await new Promise<void>((resolve) => {
    httpServer = http.createServer(app);
    httpServer.listen(0, resolve);
  });

  await register(OWNER, 'P0 Owner');
  await register(CALLEE, 'P0 Callee');
  ownerCookie = await login(OWNER);
  calleeCookie = await login(CALLEE);
  ownerId = (await request(app).get('/api/auth/me').set('Cookie', ownerCookie)).body.user.id;
  calleeId = (await request(app).get('/api/auth/me').set('Cookie', calleeCookie)).body.user.id;

  // Owner + callee end up in the same family (invite -> accept).
  const fam = await request(app).post('/api/families').set('Cookie', ownerCookie).send({ name: 'P0 Test Family' });
  expect(fam.status).toBe(201);
  familyId = fam.body.family.id;
  const inv = await request(app)
    .post(`/api/families/${familyId}/invitations`)
    .set('Cookie', ownerCookie)
    .send({ role: 'member' });
  expect(inv.status).toBe(201);
  const acc = await request(app)
    .post('/api/families/invitations/accept')
    .set('Cookie', calleeCookie)
    .send({ token: inv.body.invitation.token });
  expect(acc.status).toBe(200);
});

afterAll(async () => {
  const db = await import('../src/db/connect');
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  await db.disconnectDatabase();
  if (mongod) await mongod.stop();
});

describe('Fix 1 — LiveKit call tokens are real awaited JWTs', () => {
  it('issues a three-part JWT string (not a serialized Promise / empty object)', async () => {
    const created = await request(app)
      .post('/api/calls')
      .set('Cookie', calleeCookie)
      .send({ familyId, mode: 'audio', participantIds: [ownerId] });
    expect(created.status).toBe(201);
    const callId = created.body.call.id;

    const res = await request(app).get(`/api/calls/${callId}/token`).set('Cookie', calleeCookie);
    expect(res.status).toBe(200);
    // The old bug serialized a Promise, producing `token: {}`.
    expect(res.body.token).toEqual(expect.any(String));
    expect((res.body.token as string).length).toBeGreaterThan(100);
    expect((res.body.token as string).startsWith('eyJ')).toBe(true);
    expect(res.body.token).not.toMatch(/^\[object/);
    expect(JSON.stringify(res.body)).not.toContain('"token":{}');
  });

  it('JWT payload keeps the existing room scoping and grants', async () => {
    const created = await request(app)
      .post('/api/calls')
      .set('Cookie', ownerCookie)
      .send({ familyId, mode: 'audio', participantIds: [calleeId] });
    expect(created.status).toBe(201);
    const callId = created.body.call.id;

    const owner = await request(app).get(`/api/calls/${callId}/token`).set('Cookie', ownerCookie);
    expect(owner.status).toBe(200);
    const payload = decodeJwtPayload(owner.body.token as string);
    const video = payload.video as { room?: string; roomJoin?: boolean; canPublish?: boolean; canSubscribe?: boolean };
    expect(video.room).toBe(`family-${familyId}-call-${callId}`);
    expect(video.roomJoin).toBe(true);
    expect(video.canPublish).toBe(true);
    expect(video.canSubscribe).toBe(true);
    expect(payload.sub).toBe(ownerId);

    // The other participant can also obtain their own token (same room).
    const calleeTok = await request(app).get(`/api/calls/${callId}/token`).set('Cookie', calleeCookie);
    expect(calleeTok.status).toBe(200);
    const payloadTwo = decodeJwtPayload(calleeTok.body.token as string);
    expect((payloadTwo.video as { room?: string }).room).toBe(video.room);
    expect(payloadTwo.sub).toBe(calleeId);
  });
});

describe('Fix 2 — user responses never expose passwordHash', () => {
  it('PATCH /users/me returns a sanitized user (no passwordHash, no bcrypt material)', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set('Cookie', ownerCookie)
      .send({ name: 'P0 Owner Renamed' });
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('$2a$');
    // The update itself still works.
    expect(res.body.user.name).toBe('P0 Owner Renamed');
    // Whitelist shape still intact for the client.
    expect(res.body.user.email).toBe(OWNER);
    expect(res.body.user.privacy).toBeDefined();
    expect(res.body.user.notificationPrefs).toBeDefined();
  });

  it('GET /users/me stays sanitized too', async () => {
    const res = await request(app).get('/api/users/me').set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('$2a$');
  });
});

describe('Fix 3 — reset tokens are never sent over the API, reset workflow still works', () => {
  it('forgot-password returns no token content for a registered email', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: OWNER });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.devToken).toBeUndefined();
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('devToken');
    // raw tokens are 64 hex chars — none may appear anywhere in the response.
    expect(body).not.toMatch(/[0-9a-f]{64}/);
    // No raw token or hash leaks even if the DB holds one.
    expect(body).not.toContain('$');
    expect(body).not.toMatch(/[0-9a-f]{48}/);
  });

  it('forgot-password gives the same generic answer for an unknown email', async () => {
    const known = await request(app).post('/api/auth/forgot-password').send({ email: OWNER });
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody-p0@test.dev' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.devToken).toBeUndefined();
    expect(unknown.body.message).toBe(known.body.message);
  });

  it('the secure reset workflow still works end to end (hash at rest, single use)', async () => {
    const { generateResetToken, PasswordResetToken, hashToken } = await import('../src/models/passwordReset');
    const me = await request(app).get('/api/auth/me').set('Cookie', calleeCookie);
    const uid = me.body.user.id;

    const { raw, hash } = generateResetToken();
    // The server stores only the SHA-256 hash, never the raw token.
    const stored = await PasswordResetToken.create({
      userId: uid,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(stored.tokenHash).toBe(hashToken(raw));
    expect(stored.tokenHash).not.toBe(raw);

    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: raw, password: 'NewPassword123' });
    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);

    // New password logs in; single-use means the same token cannot repeat.
    const relogin = await request(app).post('/api/auth/login').send({ email: CALLEE, password: 'NewPassword123' });
    expect(relogin.status).toBe(200);
    const replay = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: raw, password: 'AnotherPassword123' });
    expect(replay.status).toBe(400);
  });
});
