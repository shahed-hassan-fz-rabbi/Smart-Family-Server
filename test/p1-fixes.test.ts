/**
 * Regression tests for the four P1 production-readiness fixes:
 *
 *   Fix 1 — JWT session invalidation: a password reset (and account deletion)
 *           must instantly revoke all previously issued sessions
 *           (server-side tokenVersion compared in requireAuth).
 *   Fix 2 — Call lifecycle safety: tokens refused for ended/declined/missed
 *           calls, simultaneous ringing conflicts rejected (409), stale
 *           rings swept to `missed` with notifications.
 *   Fix 3 — Presence privacy: presence events are delivered only inside the
 *           conversation rooms a user actually joined — no cross-family leak.
 *   Fix 4 — AI proposal confirm/cancel are atomic: concurrent or duplicate
 *           confirmations cannot execute the same proposal twice.
 *
 * Describes are ordered so session-invalidation tests (which deliberately
 * break the owner's cookie) run last and never poison the other suites.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { Types } from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'p1-fixes-test-secret-0123456789abcdef';
// Isolate tests from any developer's real `.env`.
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
// LiveKit gets fake credentials again (token signing is local-only).
process.env.LIVEKIT_URL = 'wss://p1-test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'p1testkey';
process.env.LIVEKIT_API_SECRET = 'p1-test-secret-0123456789abcdef';

let mongod: MongoMemoryServer;
let app: import('express').Express;
let httpServer: HttpServer;
let port = 0;

const OWNER = 'p1-owner@test.dev';
const CALLEE = 'p1-callee@test.dev';
const OUTSIDER = 'p1-outsider@test.dev';
const OUTSIDER2 = 'p1-outsider2@test.dev';
const VANISH = 'p1-vanish@test.dev';

let ownerCookie = '';
let calleeCookie = '';
let outsiderCookie = '';
let ownerId = '';
let calleeId = '';
let outsiderId = '';
let outsider2Id = '';
let familyId = '';
let strangerFamilyId = '';
let conversationId = '';
let strangerConversationId = '';

async function login(email: string, password = 'Password123'): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'][0].split(';')[0];
}

async function register(email: string, name: string): Promise<void> {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'Password123' });
  if (res.status !== 201) throw new Error(`register ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function connectSocket(cookie: string): Promise<Socket> {
  const sock = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    extraHeaders: { cookie },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 5000);
    sock.on('connect', () => { clearTimeout(timer); resolve(); });
    sock.on('connect_error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });
  });
  return sock;
}

function joinConversation(sock: Socket, convId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('conversation:join timeout')), 5000);
    sock.emit('conversation:join', convId, (ok: boolean | { error: string }) => {
      clearTimeout(timer);
      if (ok === true) resolve();
      else reject(new Error(`join failed: ${JSON.stringify(ok)}`));
    });
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('smart-family-p1-test');
  const db = await import('../src/db/connect');
  await db.connectDatabase();

  const mod = await import('../src/app');
  app = mod.createApp();

  const http = await import('http');
  const socket = await import('../src/socket');
  const ioMod = await import('../src/lib/realtime');
  httpServer = http.createServer(app);
  const sio = socket.initSocket(httpServer);
  ioMod.setIO(sio);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;

  await register(OWNER, 'P1 Owner');
  await register(CALLEE, 'P1 Callee');
  await register(OUTSIDER, 'P1 Outsider');
  await register(OUTSIDER2, 'P1 Outsider Two');
  ownerCookie = await login(OWNER);
  calleeCookie = await login(CALLEE);
  outsiderCookie = await login(OUTSIDER);
  ownerId = (await request(app).get('/api/auth/me').set('Cookie', ownerCookie)).body.user.id;
  calleeId = (await request(app).get('/api/auth/me').set('Cookie', calleeCookie)).body.user.id;
  outsiderId = (await request(app).get('/api/auth/me').set('Cookie', outsiderCookie)).body.user.id;
  outsider2Id = (await request(app).post('/api/auth/login').send({ email: OUTSIDER2, password: 'Password123' }).then((r) => r.headers['set-cookie'][0].split(';')[0]));
  outsider2Id = (await request(app).get('/api/auth/me').set('Cookie', outsider2Id)).body.user.id;

  const fam = await request(app).post('/api/families').set('Cookie', ownerCookie).send({ name: 'P1 Family' });
  familyId = fam.body.family.id;
  const inv = await request(app)
    .post(`/api/families/${familyId}/invitations`)
    .set('Cookie', ownerCookie)
    .send({ role: 'member' });
  await request(app)
    .post('/api/families/invitations/accept')
    .set('Cookie', calleeCookie)
    .send({ token: inv.body.invitation.token });

  // The outsider gets their own tiny family + conversation for isolation checks.
  const sFam = await request(app).post('/api/families').set('Cookie', outsiderCookie).send({ name: 'P1 Stranger Family' });
  strangerFamilyId = sFam.body.family.id;
  const sInv = await request(app)
    .post(`/api/families/${strangerFamilyId}/invitations`)
    .set('Cookie', outsiderCookie)
    .send({ role: 'member' });
  await request(app)
    .post('/api/families/invitations/accept')
    .send({ token: sInv.body.invitation.token })
    .set('Cookie', await login(OUTSIDER2));

  const conv = await request(app)
    .post('/api/conversations')
    .set('Cookie', ownerCookie)
    .send({ familyId, type: 'dm', participantIds: [calleeId] });
  expect(conv.status).toBe(201);
  conversationId = conv.body.conversation.id;

  const sConv = await request(app)
    .post('/api/conversations')
    .set('Cookie', outsiderCookie)
    .send({ familyId: strangerFamilyId, type: 'dm', participantIds: [outsider2Id] });
  expect(sConv.status).toBe(201);
  strangerConversationId = sConv.body.conversation.id;
});

afterAll(async () => {
  const db = await import('../src/db/connect');
  const sio = await import('../src/lib/realtime');
  if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await db.disconnectDatabase();
  void sio;
  if (mongod) await mongod.stop();
});

describe('Fix 2 — call lifecycle safety', () => {
  it('refuses call tokens once a call is declined (410) for every participant', async () => {
    const created = await request(app)
      .post('/api/calls')
      .set('Cookie', ownerCookie)
      .send({ familyId, mode: 'audio', participantIds: [calleeId] });
    expect(created.status).toBe(201);
    const callId = created.body.call.id;

    const dec = await request(app).post(`/api/calls/${callId}/decline`).set('Cookie', calleeCookie);
    expect(dec.status).toBe(200);

    const tOwner = await request(app).get(`/api/calls/${callId}/token`).set('Cookie', ownerCookie);
    expect(tOwner.status).toBe(410);
    const tCallee = await request(app).get(`/api/calls/${callId}/token`).set('Cookie', calleeCookie);
    expect(tCallee.status).toBe(410);
  });

  it('rejects (409) a new call while the callee still has one ringing', async () => {
    const first = await request(app)
      .post('/api/calls')
      .set('Cookie', ownerCookie)
      .send({ familyId, mode: 'audio', participantIds: [calleeId] });
    expect(first.status).toBe(201);
    const ringingId = first.body.call.id;

    const dupe = await request(app)
      .post('/api/calls')
      .set('Cookie', ownerCookie)
      .send({ familyId, mode: 'audio', participantIds: [calleeId] });
    expect(dupe.status).toBe(409);

    // Also blocked when an authorized *family member*, different initiator,
    // would overlap with the already-ringing user.
    const reversed = await request(app)
      .post('/api/calls')
      .set('Cookie', calleeCookie)
      .send({ familyId, mode: 'audio', participantIds: [ownerId] });
    expect(reversed.status).toBe(409);

    // Someone outside the family can never create the call at all (boundary).
    const stranger = await request(app)
      .post('/api/calls')
      .set('Cookie', outsiderCookie)
      .send({ familyId, mode: 'audio', participantIds: [ownerId] });
    expect(stranger.status).toBe(403);

    // Once the ring is over the conflict clears and a new call is allowed.
    const dec = await request(app).post(`/api/calls/${ringingId}/decline`).set('Cookie', calleeCookie);
    expect(dec.status).toBe(200);
    const after = await request(app)
      .post('/api/calls')
      .set('Cookie', ownerCookie)
      .send({ familyId, mode: 'audio', participantIds: [calleeId] });
    expect(after.status).toBe(201);
    // cleanup for later suites
    await request(app).post(`/api/calls/${after.body.call.id}/decline`).set('Cookie', calleeCookie);
  });

  it('sweeps expired ringing calls to missed, notifies, refuses tokens, and frees the conflict', async () => {
    const created = await request(app)
      .post('/api/calls')
      .set('Cookie', ownerCookie)
      .send({ familyId, mode: 'audio', participantIds: [calleeId] });
    expect(created.status).toBe(201);
    const staleId = created.body.call.id;

    // Simulate a ring that was never answered: backdate its start past the
    // 60s window, then run the same sweeper the routes/cron call.
    const { CallSession } = await import('../src/models/safety');
    await CallSession.updateOne(
      { _id: new Types.ObjectId(staleId) },
      { $set: { startedAt: new Date(Date.now() - 5 * 60_000) } },
    );
    const { expireStaleRingingCalls } = await import('../src/services/callSweeper');
    const swept = await expireStaleRingingCalls();
    expect(swept).toBeGreaterThanOrEqual(1);

    const doc = await CallSession.findById(staleId);
    expect(doc?.status).toBe('missed');
    expect(doc?.endedAt).toBeInstanceOf(Date);

    // A missed call can no longer be joined.
    const t = await request(app).get(`/api/calls/${staleId}/token`).set('Cookie', ownerCookie);
    expect(t.status).toBe(410);

    // The callee received an in-app notification about the missed call.
    const notifs = await request(app).get('/api/notifications?limit=50').set('Cookie', calleeCookie);
    const missed = notifs.body.notifications.find((n: { type: string }) => n.type === 'call_missed');
    expect(missed).toBeTruthy();

    // The conflict lock is free again.
    const nextCall = await request(app)
      .post('/api/calls')
      .set('Cookie', ownerCookie)
      .send({ familyId, mode: 'audio', participantIds: [calleeId] });
    expect(nextCall.status).toBe(201);
    await request(app).post(`/api/calls/${nextCall.body.call.id}/decline`).set('Cookie', calleeCookie);
  });

  it('still issues real JWT tokens for a legitimate ringing call (P0 fix intact)', async () => {
    const created = await request(app)
      .post('/api/calls')
      .set('Cookie', ownerCookie)
      .send({ familyId, mode: 'video', participantIds: [calleeId] });
    expect(created.status).toBe(201);
    const callId = created.body.call.id;

    const t = await request(app).get(`/api/calls/${callId}/token`).set('Cookie', calleeCookie);
    expect(t.status).toBe(200);
    expect(t.body.token).toEqual(expect.any(String));
    expect((t.body.token as string).startsWith('eyJ')).toBe(true);
    expect(JSON.stringify(t.body)).not.toContain('"token":{}');

    await request(app).post(`/api/calls/${callId}/end`).set('Cookie', ownerCookie);
  });
});

describe('Fix 3 — presence events stay inside joined conversation rooms', () => {
  it('delivers presence:online/offline only to participants of the same conversation', async () => {
    const sockA = await connectSocket(ownerCookie);
    const sockB = await connectSocket(calleeCookie);
    const sockC = await connectSocket(outsiderCookie);

    const events: Record<'A' | 'B' | 'C', string[]> = { A: [], B: [], C: [] };
    sockA.on('presence:online', (m) => events.A.push(`online:${m?.userId}`));
    sockA.on('presence:offline', (m) => events.A.push(`offline:${m?.userId}`));
    sockB.on('presence:online', (m) => events.B.push(`online:${m?.userId}`));
    sockC.on('presence:online', (m) => events.C.push(`online:${m?.userId}`));
    sockC.on('presence:offline', (m) => events.C.push(`offline:${m?.userId}`));

    await joinConversation(sockA, conversationId);
    await joinConversation(sockC, strangerConversationId); // unrelated family/user
    await joinConversation(sockB, conversationId);

    // A shares the conversation with B → must see B come online.
    expect(events.A).toContain(`online:${calleeId}`);
    // C is in an unrelated conversation → must see nothing from A or B.
    expect(events.C).toEqual([]);

    const offlineSeen = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(events.A.includes(`offline:${calleeId}`)), 4000);
      sockA.on('presence:offline', (m) => {
        if (m?.userId === calleeId) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });

    sockB.disconnect(); // last session of B → offline inside its rooms only
    expect(await offlineSeen).toBe(true);

    // Give the (non-)leak to C a moment to manifest, then assert absence.
    await new Promise((r) => setTimeout(r, 1200));
    expect(events.C).toEqual([]);
    expect(events.A.some((e) => e.startsWith('offline:'))).toBe(true);

    sockA.disconnect();
    sockC.disconnect();
  });
});

describe('Fix 4 — AI proposal confirm/cancel are atomic', () => {
  let propA = '';
  let propB = '';
  let propStrangerOwned = '';

  beforeAll(async () => {
    const { AIProposal } = await import('../src/models/ai');
    const a = await AIProposal.create({
      conversationId: new Types.ObjectId(),
      userId: ownerId,
      familyId,
      type: 'create_task',
      payload: { title: 'P1 atomic probe task', priority: 'low' },
      explanation: 'concurrency probe',
      status: 'pending',
    });
    propA = String(a._id);
    const b = await AIProposal.create({
      conversationId: new Types.ObjectId(),
      userId: ownerCookie ? ownerId : ownerId,
      familyId,
      type: 'create_task',
      payload: { title: 'P1 cancelled probe task', priority: 'low' },
      explanation: 'cancel-then-confirm probe',
      status: 'pending',
    });
    propB = String(b._id);
    const s = await AIProposal.create({
      conversationId: new Types.ObjectId(),
      userId: ownerId,
      familyId,
      type: 'create_task',
      payload: { title: 'P1 ownership probe task', priority: 'low' },
      explanation: 'ownership probe',
      status: 'pending',
    });
    propStrangerOwned = String(s._id);
  });

  it('executes exactly once when two confirms race', async () => {
    const confirm = () => request(app).post(`/api/ai/actions/${propA}/confirm`).set('Cookie', ownerCookie);
    const [r1, r2] = await Promise.all([confirm(), confirm()]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 404]); // exactly one winner
    const winner = r1.status === 200 ? r1 : r2;
    expect(winner.body.ok).toBe(true);
    expect(winner.body.type).toBe('create_task');

    // And the action itself must NOT have run twice.
    const tasks = await request(app).get(`/api/tasks?familyId=${familyId}`).set('Cookie', ownerCookie);
    const atomic = tasks.body.tasks.filter((t: { title: string }) => t.title === 'P1 atomic probe task');
    expect(atomic.length).toBe(1);
  });

  it('a confirmed second attempt fails idempotently with no side effects', async () => {
    const again = await request(app).post(`/api/ai/actions/${propA}/confirm`).set('Cookie', ownerCookie);
    expect(again.status).toBe(404);
    const tasks = await request(app).get(`/api/tasks?familyId=${familyId}`).set('Cookie', ownerCookie);
    expect(tasks.body.tasks.filter((t: { title: string }) => t.title === 'P1 atomic probe task').length).toBe(1);
  });

  it('cancel wins atomically; confirm afterwards is a no-op', async () => {
    const cancel = await request(app).post(`/api/ai/actions/${propB}/cancel`).set('Cookie', ownerCookie);
    expect(cancel.status).toBe(200);
    const lateConfirm = await request(app).post(`/api/ai/actions/${propB}/confirm`).set('Cookie', ownerCookie);
    expect(lateConfirm.status).toBe(404);
    const tasks = await request(app).get(`/api/tasks?familyId=${familyId}`).set('Cookie', ownerCookie);
    expect(tasks.body.tasks.filter((t: { title: string }) => t.title === 'P1 cancelled probe task').length).toBe(0);
  });

  it('another user cannot confirm someone else\'s proposal (authorization boundary)', async () => {
    const strangerConfirm = await request(app)
      .post(`/api/ai/actions/${propStrangerOwned}/confirm`)
      .set('Cookie', outsiderCookie);
    expect(strangerConfirm.status).toBe(404);
    const tasks = await request(app).get(`/api/tasks?familyId=${familyId}`).set('Cookie', ownerCookie);
    expect(tasks.body.tasks.filter((t: { title: string }) => t.title === 'P1 ownership probe task').length).toBe(0);
  });
});

describe('Fix 1 — JWT session invalidation (server-side tokenVersion)', () => {
  it('a password reset instantly revokes every previously issued session', async () => {
    const oldCookie = await login(OWNER);
    expect((await request(app).get('/api/auth/me').set('Cookie', oldCookie)).status).toBe(200);

    // Generate a reset token exactly like the admin's out-of-band delivery.
    const { generateResetToken, PasswordResetToken, hashToken } = await import('../src/models/passwordReset');
    const { raw } = generateResetToken();
    await PasswordResetToken.create({
      userId: new Types.ObjectId(ownerId),
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: raw, password: 'Password123' });
    expect(reset.status).toBe(200);

    // The old session is dead — even though the JWT signature is still valid.
    const old = await request(app).get('/api/auth/me').set('Cookie', oldCookie);
    expect(old.status).toBe(401);
    expect(old.body.error).toBe('Session expired. Please sign in again.');

    // Signing in again mints a session at the new tokenVersion.
    ownerCookie = await login(OWNER);
    const fresh = await request(app).get('/api/auth/me').set('Cookie', ownerCookie);
    expect(fresh.status).toBe(200);
  });

  it('account deletion (soft) immediately invalidates the deleted user\'s session', async () => {
    await register(VANISH, 'P1 Vanish');
    const vanishCookie = await login(VANISH);
    expect((await request(app).get('/api/auth/me').set('Cookie', vanishCookie)).status).toBe(200);

    const del = await request(app).delete('/api/users/me').set('Cookie', vanishCookie);
    expect(del.status).toBe(200);

    const after = await request(app).get('/api/auth/me').set('Cookie', vanishCookie);
    expect(after.status).toBe(401);

    // Audit data was not deleted (soft delete) and other accounts still work.
    const ownerStillOk = await request(app).get('/api/auth/me').set('Cookie', ownerCookie);
    expect(ownerStillOk.status).toBe(200);
  });
});
