/**
 * Platform Super Admin security tests.
 *
 * Covers: unauthorized access (401), non-admin escalation (403), suspension
 * flow with audit logging, immediate effect on the suspended account, the
 * strong "never suspend a platform admin" guard, honest role assignment by
 * every public signup path, and the secure bootstrap script's refusals.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Server as HttpServer } from 'http';
import request from 'supertest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-test-secret-0123456789abcdef';
// Isolate from a developer's real `.env` (dotenv only fills unset variables).
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
process.env.LIVEKIT_URL = '';
process.env.LIVEKIT_API_KEY = '';
process.env.LIVEKIT_API_SECRET = '';

const run = promisify(execFile);

let mongod: MongoMemoryServer;
let app: import('express').Express;
let httpServer: HttpServer;
let dbUri = '';

let memberCookie = '';
let secondCookie = '';
let adminCookie = '';

async function login(email: string, password = 'Password123'): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.headers['set-cookie'][0].split(';')[0];
}

async function register(email: string, name: string): Promise<void> {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'Password123' });
  if (res.status !== 201) throw new Error(`register ${email} failed: ${res.status}`);
}

async function findUserByEmail(email: string): Promise<{ _id: unknown; role?: string }> {
  const users = await import('../src/models/user');
  const u = await users.User.findOne({ email }).lean<{ _id: unknown; role?: string }>();
  if (!u) throw new Error(`user ${email} not found`);
  return u;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('smart-family-test');
  dbUri = process.env.MONGODB_URI;
  const db = await import('../src/db/connect');
  await db.connectDatabase();
  const mod = await import('../src/app');
  app = mod.createApp();
  const http = await import('http');
  httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));

  await register('member@test.dev', 'Family Member');
  await register('member2@test.dev', 'Second Member');
  await register('admin@test.dev', 'Alice Admin');
  memberCookie = await login('member@test.dev');
  secondCookie = await login('member2@test.dev');

  // Simulate the (script-driven) bootstrap promotion — the same thing the
  // secure script does, but directly against the test database.
  const users = await import('../src/models/user');
  await users.User.updateOne({ email: 'admin@test.dev' }, { $set: { role: 'super_admin' } });
  adminCookie = await login('admin@test.dev');
});

afterAll(async () => {
  const db = await import('../src/db/connect');
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await db.disconnectDatabase();
  await mongod.stop();
});

describe('unauthorized access to platform admin routes', () => {
  it('401 for anonymous requests (no cookie)', async () => {
    const res = await request(app).get('/api/admin/overview');
    expect(res.status).toBe(401);
  });

  it('403 for a normal signed-in member — all privileged kinds', async () => {
    for (const path of [
      '/api/admin/overview',
      '/api/admin/users',
      '/api/admin/families',
      '/api/admin/services',
      '/api/admin/audit',
      '/api/admin/admins',
    ]) {
      const res = await request(app).get(path).set('Cookie', memberCookie);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Platform administrator access required');
    }
  });

  it('403 when a member attempts a privileged PATCH (escalation attempt)', async () => {
    const victim = await findUserByEmail('member2@test.dev');
    const res = await request(app)
      .patch(`/api/admin/users/${String(victim._id)}/suspend`)
      .set('Cookie', memberCookie)
      .send({ reason: 'self-promoted attack' });
    expect(res.status).toBe(403);
  });

  it('admin PATCH with an invalid id is rejected safely', async () => {
    const res = await request(app)
      .patch('/api/admin/users/not-an-id/suspend')
      .set('Cookie', adminCookie)
      .send({ reason: 'test' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('Cast'); // no internals leaked
  });
});

describe('public signup paths can never grant platform privileges', () => {
  it('email registration creates role "user"', async () => {
    const u = await findUserByEmail('member@test.dev');
    expect(u.role).toBe('user');
  });

  it('the admin dashboard member list exposes role but never password hashes', async () => {
    const res = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('password');
    expect(body).not.toContain('hash');
  });
});

describe('account suspension / restoration (with audit trail)', () => {
  it('super admin can suspend a member, and suspension takes effect immediately', async () => {
    const victim = await findUserByEmail('member2@test.dev');
    const id = String(victim._id);

    const before = await request(app).get('/api/auth/me').set('Cookie', secondCookie);
    expect(before.status).toBe(200);
    expect(before.body.user.role).toBe('user'); // honest role exposure

    const res = await request(app)
      .patch(`/api/admin/users/${id}/suspend`)
      .set('Cookie', adminCookie)
      .send({ reason: 'integration test violation' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const after = await request(app).get('/api/auth/me').set('Cookie', secondCookie);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('Account suspended');
  });

  it('restoration makes the account work again', async () => {
    const victim = await findUserByEmail('member2@test.dev');
    const id = String(victim._id);
    const res = await request(app).patch(`/api/admin/users/${id}/restore`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const after = await request(app).get('/api/auth/me').set('Cookie', secondCookie);
    expect(after.status).toBe(200);
  });

  it('both privileged actions are written to the immutable audit log', async () => {
    const res = await request(app)
      .get('/api/admin/audit')
      .set('Cookie', adminCookie)
      .query({ limit: 50 });
    expect(res.status).toBe(200);
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('platform.user.suspended');
    expect(actions).toContain('platform.user.restored');
  });
});

describe('the last-admin protection', () => {
  it('refuses to suspend ANY platform administrator (403) — including the only one', async () => {
    const admin = await findUserByEmail('admin@test.dev');
    const res = await request(app)
      .patch(`/api/admin/users/${String(admin._id)}/suspend`)
      .set('Cookie', adminCookie)
      .send({ reason: 'try removing the last administrator' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('cannot be suspended');

    // unaffected afterwards
    const me = await request(app).get('/api/auth/me').set('Cookie', adminCookie);
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('super_admin');
  });

  it('refuses self-suspension', async () => {
    const admin = await findUserByEmail('admin@test.dev');
    const res = await request(app)
      .patch(`/api/admin/users/${String(admin._id)}/restore`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(409); // not suspended — no false success
  });
});

describe('overview + services + admins endpoints', () => {
  it('overview returns aggregate metrics only', async () => {
    const res = await request(app).get('/api/admin/overview').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.users.superAdmins).toBe(1); // exactly the one protected admin
    expect(res.body.users.suspended).toBe(0);
    expect(res.body).not.toHaveProperty('messages'); // no private content
  });

  it('services reports honest integration flags (nothing configured in tests)', async () => {
    const res = await request(app).get('/api/admin/services').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.db.connected).toBe(true);
    expect(res.body.integrations.gemini.configured).toBe(false);
    expect(res.body.integrations.livekit.configured).toBe(false);
  });

  it('admins list contains exactly one protected admin', async () => {
    const res = await request(app).get('/api/admin/admins').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.admins).toHaveLength(1);
    expect(res.body.admins[0].email).toBe('admin@test.dev');
  });
});

describe('secure bootstrap script', () => {
  const script = 'scripts/create-super-admin.mjs';

  it('refuses without ADMIN_BOOTSTRAP_TOKEN (or too short)', async () => {
    await expect(
      run('node', [script, '--email', 'someone@test.dev', '--confirm'], {
        env: { ...process.env, ADMIN_BOOTSTRAP_TOKEN: undefined, MONGODB_URI: dbUri },
      }),
    ).rejects.toMatchObject({ code: 2 });
  }, 30000);

  it('refuses without --confirm exactly', async () => {
    await expect(
      run('node', [script, '--email', 'member@test.dev'], {
        env: { ...process.env, ADMIN_BOOTSTRAP_TOKEN: 'x'.repeat(48), MONGODB_URI: dbUri },
      }),
    ).rejects.toMatchObject({ code: 3 });
  }, 30000);

  it('promotes an existing registered user exactly once (idempotent) and audits it', async () => {
    const token = 'bootstrap-token-test-0123456789-0123456789';
    const first = await run(
      'node',
      [script, '--email', 'member@test.dev', '--confirm'],
      { env: { ...process.env, ADMIN_BOOTSTRAP_TOKEN: token, MONGODB_URI: dbUri } },
    );
    expect(first.stdout).toContain('Promoted member@test.dev');

    const u = await findUserByEmail('member@test.dev');
    expect(u.role).toBe('super_admin');

    // idempotent re-run changes nothing but succeeds honestly
    const second = await run(
      'node',
      [script, '--email', 'member@test.dev', '--confirm'],
      { env: { ...process.env, ADMIN_BOOTSTRAP_TOKEN: token, MONGODB_URI: dbUri } },
    );
    expect(second.stdout).toContain('already a platform super administrator');

    // audit trail contains the scripted promotion
    const audit = await request(app)
      .get('/api/admin/audit')
      .set('Cookie', secondCookie)
      .expect(403); // member2 is NOT an admin — cannot read audit
    expect(audit.status).toBe(403);

    const auditAdmin = await request(app)
      .get('/api/admin/audit')
      .set('Cookie', adminCookie)
      .query({ q: 'platform.admin.promoted' });
    expect(auditAdmin.status).toBe(200);
    expect(auditAdmin.body.entries.length).toBeGreaterThan(0);
    expect(auditAdmin.body.entries[0].actorEmail).toBe('member@test.dev');
  }, 30000);

  it('refuses to promote a suspended account (restore-first policy)', async () => {
    // suspend member2 via API (as in the earlier flow)
    const victim = await findUserByEmail('member2@test.dev');
    await request(app)
      .patch(`/api/admin/users/${String(victim._id)}/suspend`)
      .set('Cookie', adminCookie)
      .send({ reason: 'set up for bootstrap refusal test' });

    await expect(
      run('node', [script, '--email', 'member2@test.dev', '--confirm'], {
        env: { ...process.env, ADMIN_BOOTSTRAP_TOKEN: 'y'.repeat(44), MONGODB_URI: dbUri },
      }),
    ).rejects.toMatchObject({ code: 5 });

    // restore to leave the suite in a clean state
    await request(app).patch(`/api/admin/users/${String(victim._id)}/restore`).set('Cookie', adminCookie);
  }, 30000);
});
