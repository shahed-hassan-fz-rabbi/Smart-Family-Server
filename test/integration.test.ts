/**
 * End-to-end integration tests against a real (in-memory) MongoDB and the
 * actual Express app + Socket.IO server.
 *
 * Covers: registration/login/session, family creation/invitations/authorization
 * boundaries, task CRUD + role permissions, calendar validation + conflict
 * detection, reminders, AI conversation persistence (unconfigured-provider
 * fallback), family chat REST + Socket.IO delivery, and 401/403 boundaries.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-test-secret-0123456789abcdef';
// Isolate tests from any developer's real `.env` (e.g. a live GEMINI_API_KEY):
// dotenv only fills UNSET variables, so pre-setting empty values keeps the
// "not configured" integrations honestly unconfigured inside tests.
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
process.env.LIVEKIT_URL = '';
process.env.LIVEKIT_API_KEY = '';
process.env.LIVEKIT_API_SECRET = '';

let mongod: MongoMemoryServer;
let app: import('express').Express;
let httpServer: HttpServer;

let memberCookie = '';
let otherCookie = '';
let outsideCookie = '';

const A = 'a'.repeat(24);

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'][0].split(';')[0];
}

async function register(email: string, name: string): Promise<void> {
  const res = await request(app).post('/api/auth/register').send({
    email,
    name,
    password: 'Password123',
  });
  if (res.status !== 201) throw new Error(`register ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('smart-family-test');
  const db = await import('../src/db/connect');
  await db.connectDatabase();

  const mod = await import('../src/app');
  app = mod.createApp();

  // boot socket layer
  const http = await import('http');
  const socket = await import('../src/socket');
  const ioMod = await import('../src/lib/realtime');
  httpServer = http.createServer(app);
  const sio = socket.initSocket(httpServer);
  ioMod.setIO(sio);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
});

afterAll(async () => {
  const db = await import('../src/db/connect');
  const sio = await import('../src/lib/realtime');
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  await db.disconnectDatabase();
  void sio;
  if (mongod) await mongod.stop();
});

describe('health', () => {
  it('reports service status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.dbConnected).toBe(true);
    expect(res.body.aiConfigured).toBe(false); // no GEMINI key in tests — honest
  });
});

describe('Google sign-in (honest gating)', () => {
  it('reports which providers are actually configured', async () => {
    const res = await request(app).get('/api/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body.google).toBe(false); // no GOOGLE_CLIENT_ID in tests — honest
  });

  it('does not send users to Google when it is not configured', async () => {
    const res = await request(app).get('/api/auth/google').expect(302);
    expect(res.headers.location).not.toContain('accounts.google.com');
    expect(res.headers.location).toContain('google=not_configured');
  });
});

describe('authentication', () => {
  const email = 'rafi@test.dev';
  it('registers a user', async () => {
    const res = await request(app).post('/api/auth/register').send({ email, name: 'Rafi', password: 'Password123' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    // Must never leak the hash
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('rejects duplicate accounts', async () => {
    const res = await request(app).post('/api/auth/register').send({ email, name: 'Rafi Again', password: 'Password123' });
    expect(res.status).toBe(409);
  });

  it('rejects short passwords', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'x@y.dev', name: 'X', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects wrong password with a uniform error', async () => {
    const res = await request(app).post('/api/auth/login').send({ email, password: 'WrongPassword1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('logs in and returns a session cookie', async () => {
    memberCookie = await login(email, 'Password123');
    expect(memberCookie).toContain('sf_token=');
  });

  it('protects /me without a session', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the current user with a valid session', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', memberCookie);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });
});

describe('families, invitations and authorization boundaries', () => {
  let familyId = '';
  it('creates a family (creator becomes owner)', async () => {
    const res = await request(app).post('/api/families').set('Cookie', memberCookie).send({ name: 'Hassan Family' });
    expect(res.status).toBe(201);
    expect(res.body.family.role).toBe('owner');
    familyId = res.body.family.id;
  });

  it('registers a family member and an outsider', async () => {
    await register('nusrat@test.dev', 'Nusrat');
    await register('outsider@test.dev', 'Outside Person');
    otherCookie = await login('nusrat@test.dev', 'Password123');
    outsideCookie = await login('outsider@test.dev', 'Password123');
  });

  it('owner creates an invitation token', async () => {
    const res = await request(app).post(`/api/families/${familyId}/invitations`).set('Cookie', memberCookie).send({ role: 'member' });
    expect(res.status).toBe(201);
    expect(res.body.invitation.token).toBeTruthy();
    process.env.INVITE_TOKEN = res.body.invitation.token;
  });

  it('invitee accepts the invitation and joins', async () => {
    const res = await request(app).post('/api/families/invitations/accept').set('Cookie', otherCookie).send({
      token: process.env.INVITE_TOKEN,
    });
    expect(res.status).toBe(200);
  });

  it('a consumed invitation cannot be reused', async () => {
    const res = await request(app).post('/api/families/invitations/accept').set('Cookie', outsideCookie).send({
      token: process.env.INVITE_TOKEN,
    });
    expect(res.status).toBe(400);
  });

  it('an outsider cannot see family data (guessed ids do not help)', async () => {
    const res = await request(app).get(`/api/families/${familyId}`).set('Cookie', outsideCookie);
    expect(res.status).toBe(403);
  });

  it('an unauthenticated request is rejected', async () => {
    const res = await request(app).get(`/api/families/${familyId}`);
    expect(res.status).toBe(401);
  });
});

describe('tasks', () => {
  let familyId = '';
  beforeAll(async () => {
    const res = await request(app).get('/api/families').set('Cookie', memberCookie);
    familyId = res.body.families[0].id;
  });

  it('creates a task assigned to the other member', async () => {
    const other = await request(app).get(`/api/families/${familyId}`).set('Cookie', memberCookie);
    const assignee = other.body.members.find((m: { name: string }) => m.name === 'Nusrat');
    const res = await request(app).post('/api/tasks').set('Cookie', memberCookie).send({
      familyId,
      title: 'Pack medicine bag',
      priority: 'high',
      dueDate: new Date(Date.now() + 86400000).toISOString(),
      assigneeId: assignee.userId,
    });
    expect(res.status).toBe(201);
    process.env.TASK_ID = res.body.task.id;
  });

  it('rejects invalid due dates', async () => {
    const res = await request(app).post('/api/tasks').set('Cookie', memberCookie).send({
      familyId,
      title: 'Bad task',
      dueDate: 'not-a-date',
    });
    expect(res.status).toBe(400);
  });

  it('lists tasks for a member', async () => {
    const res = await request(app).get(`/api/tasks?familyId=${familyId}`).set('Cookie', otherCookie);
    expect(res.status).toBe(200);
    expect(res.body.tasks.some((t: { title: string }) => t.title === 'Pack medicine bag')).toBe(true);
  });

  it('blocks outsiders from reading tasks', async () => {
    const res = await request(app).get(`/api/tasks?familyId=${familyId}`).set('Cookie', outsideCookie);
    expect(res.status).toBe(403);
  });

  it('marks the task complete', async () => {
    const res = await request(app).patch(`/api/tasks/${process.env.TASK_ID}`).set('Cookie', otherCookie).send({
      familyId,
      status: 'completed',
    });
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('completed');
  });
});

describe('calendar', () => {
  let familyId = '';
  beforeAll(async () => {
    const res = await request(app).get('/api/families').set('Cookie', memberCookie);
    familyId = res.body.families[0].id;
  });

  it('creates an event', async () => {
    const res = await request(app).post('/api/calendar/events').set('Cookie', memberCookie).send({
      familyId,
      title: 'Doctor appointment',
      startAt: new Date(Date.now() + 3600000).toISOString(),
      endAt: new Date(Date.now() + 7200000).toISOString(),
      category: 'appointment',
    });
    expect(res.status).toBe(201);
  });

  it('rejects events ending before starting', async () => {
    const res = await request(app).post('/api/calendar/events').set('Cookie', memberCookie).send({
      familyId,
      title: 'Backwards',
      startAt: new Date(Date.now() + 7200000).toISOString(),
      endAt: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it('detects overlapping events sharing a participant', async () => {
    await request(app).post('/api/calendar/events').set('Cookie', memberCookie).send({
      familyId,
      title: 'Overlapping family dinner',
      startAt: new Date(Date.now() + 5400000).toISOString(), // inside the first event
      endAt: new Date(Date.now() + 6300000).toISOString(),
      category: 'family_event',
    });
    const res = await request(app).get(`/api/calendar/events/conflicts?familyId=${familyId}`).set('Cookie', memberCookie);
    expect(res.status).toBe(200);
    expect(res.body.conflicts.length).toBeGreaterThan(0);
  });
});

describe('reminders', () => {
  let familyId = '';
  beforeAll(async () => {
    const res = await request(app).get('/api/families').set('Cookie', memberCookie);
    familyId = res.body.families[0].id;
  });

  it('creates a recurring family reminder', async () => {
    const res = await request(app).post('/api/reminders').set('Cookie', memberCookie).send({
      familyId,
      title: 'Review next week schedule',
      dueAt: new Date(Date.now() + 3600000).toISOString(),
      recurrence: 'weekly',
      remindFamily: true,
      recipientIds: [],
    });
    expect(res.status).toBe(201);
  });

  it('rejects a reminder without a date', async () => {
    const res = await request(app).post('/api/reminders').set('Cookie', memberCookie).send({
      familyId,
      title: 'No date',
      dueAt: 'nope',
      recipientIds: [],
    });
    expect(res.status).toBe(400);
  });
});

describe('AI conversations', () => {
  it('reports honestly when Gemini is not configured', async () => {
    const res = await request(app).post('/api/ai/conversations').set('Cookie', memberCookie).send({
      content: 'Mother has an appointment tomorrow, help',
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('AI_NOT_CONFIGURED');
    expect(res.body.messages.length).toBe(2); // user message + honest assistant fallback persisted
  });

  it('lists personal conversations only', async () => {
    const res = await request(app).get('/api/ai/conversations').set('Cookie', memberCookie);
    expect(res.status).toBe(200);
    expect(res.body.conversations.length).toBeGreaterThan(0);
    const convRes = await request(app)
      .get(`/api/ai/conversations/${res.body.conversations[0].id}`)
      .set('Cookie', otherCookie);
    expect(convRes.status).toBe(404); // A AI conversations are personal
  });
});

describe('family chat (REST + Socket.IO)', () => {
  let familyId = '';
  let conversationId = '';
  let memberSocket: Socket | null = null;
  let otherSocket: Socket | null = null;

  beforeAll(async () => {
    const res = await request(app).get('/api/families').set('Cookie', memberCookie);
    familyId = res.body.families[0].id;
  });

  afterAll(() => {
    memberSocket?.disconnect();
    otherSocket?.disconnect();
  });

  it('creates a direct conversation between the two members', async () => {
    const nusrat = await request(app).get(`/api/families/${familyId}`).set('Cookie', memberCookie);
    const other = nusrat.body.members.find((m: { name: string }) => m.name === 'Nusrat');
    const res = await request(app).post('/api/conversations').set('Cookie', memberCookie).send({
      familyId,
      type: 'dm',
      participantIds: [other.userId],
    });
    expect(res.status).toBe(201);
    conversationId = res.body.conversation.id;
  });

  it('refuses a dupe dm and returns the existing conversation', async () => {
    const nusrat = await request(app).get(`/api/families/${familyId}`).set('Cookie', memberCookie);
    const other = nusrat.body.members.find((m: { name: string }) => m.name === 'Nusrat');
    const res = await request(app).post('/api/conversations').set('Cookie', memberCookie).send({
      familyId,
      type: 'dm',
      participantIds: [other.userId],
    });
    expect(res.status).toBe(200);
    expect(res.body.existed).toBe(true);
  });

  it('an outsider cannot read the conversation even with the id', async () => {
    const res = await request(app).get(`/api/conversations/${conversationId}/messages`).set('Cookie', outsideCookie);
    expect(res.status).toBe(403);
  });

  it('sends a message and delivers it in real time to the other participant', async () => {
    const port = (httpServer.address() as AddressInfo).port;
    const base = `http://localhost:${port}`;

    // Both connect with their session cookies
    const memberRes = await request(app).get('/api/health').set('Cookie', memberCookie); // warm connection
    expect(memberRes.status).toBe(200);

    const cfg = (await import('../src/config/env')).config;

    memberSocket = io(base, {
      withCredentials: true,
      extraHeaders: { cookie: memberCookie },
      transports: ['websocket'],
    });
    otherSocket = io(base, {
      withCredentials: true,
      extraHeaders: { cookie: otherCookie },
      transports: ['websocket'],
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        memberSocket!.on('connect', resolve);
        memberSocket!.on('connect_error', (e) => reject(new Error(`member socket: ${e.message}`)));
        setTimeout(() => reject(new Error('member socket timeout')), 8000);
      }),
      new Promise<void>((resolve, reject) => {
        otherSocket!.on('connect', resolve);
        otherSocket!.on('connect_error', (e) => reject(new Error(`other socket: ${e.message}`)));
        setTimeout(() => reject(new Error('other socket timeout')), 8000);
      }),
    ]);
    expect(cfg).toBeTruthy();

    // Other side joins the authorized room and listens
    const joined = new Promise<unknown>((resolve) => otherSocket!.emit('conversation:join', conversationId, (r: unknown) => resolve(r)));
    expect(await joined).toBe(true);

    const received = new Promise<{ conversationId: string; message: { content: string; senderId: string } }>((resolve) => {
      otherSocket!.on('chat:new-message', (p: never) => resolve(p));
      setTimeout(() => resolve({ conversationId: '', message: { content: '', senderId: '' } }), 8000);
    });

    // Send over REST as the sending member (sender id from cookie, not from payload)
    const sendRes = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', memberCookie).send({
      content: 'Reminder set for the appointment tomorrow',
      clientId: 'test-1',
    });
    expect(sendRes.status).toBe(201);

    const got = await received;
    expect(got.conversationId).toBe(conversationId);
    expect(got.message.content).toBe('Reminder set for the appointment tomorrow');
    expect(got.message.senderId).not.toBe(''); // server-resolved identity, never trusted from client
  });

  it('streams message history from the backend', async () => {
    const res = await request(app).get(`/api/conversations/${conversationId}/messages?limit=10`).set('Cookie', memberCookie);
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBe(1);
    expect(res.body.messages[0].content).toBe('Reminder set for the appointment tomorrow');
  });

  it('rejects empty messages', async () => {
    const res = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', memberCookie).send({ content: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('calling authorization', () => {
  it('reports that LiveKit is unconfigured instead of faking a token', async () => {
    // create a call between the two members first
    const me = await request(app).get('/api/families').set('Cookie', memberCookie);
    const familyId = me.body.families[0].id;
    const detail = await request(app).get(`/api/families/${familyId}`).set('Cookie', memberCookie);
    const other = detail.body.members.find((m: { name: string }) => m.name === 'Nusrat');
    const call = await request(app).post('/api/calls').set('Cookie', memberCookie).send({
      familyId,
      mode: 'audio',
      participantIds: [other.userId],
    });
    expect(call.status).toBe(201);

    const res = await request(app).get(`/api/calls/${call.body.call.id}/token`).set('Cookie', memberCookie);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('CALLING_NOT_CONFIGURED');
  });

  it('rejects a non-participant requesting call tokens', async () => {
    const me = await request(app).get('/api/families').set('Cookie', memberCookie);
    const familyId = me.body.families[0].id;
    const detail = await request(app).get(`/api/families/${familyId}`).set('Cookie', memberCookie);
    const other = detail.body.members.find((m: { name: string }) => m.name === 'Nusrat');
    const call = await request(app).post('/api/calls').set('Cookie', memberCookie).send({
      familyId,
      mode: 'audio',
      participantIds: [other.userId],
    });
    const res = await request(app).get(`/api/calls/${call.body.call.id}/token`).set('Cookie', outsideCookie);
    expect(res.status).toBe(403);
  });

  it('lets a member leave through /members/me (not the :membershipId route)', async () => {
    const me = await request(app).get('/api/families').set('Cookie', otherCookie);
    const familyId = me.body.families[0].id;
    const leave = await request(app).delete(`/api/families/${familyId}/members/me`).set('Cookie', otherCookie);
    expect(leave.status).toBe(200);

    const after = await request(app).get(`/api/families/${familyId}`).set('Cookie', memberCookie);
    expect(after.status).toBe(200);
    expect(after.body.members.map((m: { name: string }) => m.name)).not.toContain('Nusrat');
  });
});
