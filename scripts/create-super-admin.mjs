#!/usr/bin/env node
/**
 * Secure bootstrap for the FIRST Platform Super Admin (idempotent, audited).
 *
 * Deliberate safety design (nothing hardcoded, nothing secret printed):
 *  - Requires ADMIN_BOOTSTRAP_TOKEN >= 32 chars in the environment (never
 *    echoed, never accepted via argv — so it cannot land in shell history).
 *  - Only PROMOTES an existing registered user (--email). It never creates an
 *    account and never sets a password.
 *  - Refuses unless --confirm is explicitly passed.
 *  - Refuses to work against a suspended or deleted account.
 *  - Writes an immutable audit trail entry (action: platform.admin.promoted).
 *  - There is intentionally NO demote command. To rotate administrators,
 *    promote a second person first (least-privilege handover).
 *
 * Usage (local dev or `Render Shell` on the backend service):
 *   ADMIN_BOOTSTRAP_TOKEN=<32+ char secret> node scripts/create-super-admin.mjs \
 *     --email you@example.com --confirm
 *
 * Set ADMIN_BOOTSTRAP_TOKEN as a private env var on the host (Render →
 * Environment) rather than typing it inline, so it never lands in history.
 */
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';

function fail(msg, code = 1) {
  console.error(`Refused: ${msg}`);
  process.exit(code);
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    confirm: { type: 'boolean', default: false },
  },
});

const rawToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
if (!rawToken || rawToken.length < 32) {
  fail('ADMIN_BOOTSTRAP_TOKEN is missing or shorter than 32 characters. Set it privately on the host first.', 2);
}
if (!values.confirm) {
  fail('pass --confirm to acknowledge promoting this account to Platform Super Admin', 3);
}
const email = String(values.email || '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  fail('pass a valid registered account email via --email', 3);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  fail('MONGODB_URI is not set in this environment', 4);
}

await mongoose.connect(uri, { dbName: undefined });
try {
  const db = mongoose.connection.db;
  if (!db) fail('database handle unavailable', 4);

  const user = await db.collection('users').findOne({ email, deletedAt: null });
  if (!user) {
    fail(`no registered account with that email exists — registration must happen through the app first`, 5);
  }
  if (user.role === 'super_admin') {
    console.log(`${email} is already a platform super administrator — nothing changed (idempotent).`);
    await mongoose.disconnect();
    process.exit(0);
  }
  if (user.suspendedAt) {
    fail('that account is suspended; restore it first, then bootstrap', 5);
  }

  const adminCount = await db.collection('users').countDocuments({ role: 'super_admin', deletedAt: null });
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { role: 'super_admin', updatedAt: new Date() } },
  );
  await db.collection('auditlogs').insertOne({
    actorId: user._id,
    actorEmail: email,
    action: 'platform.admin.promoted',
    targetType: 'user',
    targetId: user._id,
    meta: {
      email,
      via: 'bootstrap-script',
      actingAdminsBefore: adminCount,
      note: 'first-in-platform bootstrap promotion (or a later scripted promotion)',
    },
    createdAt: new Date(),
  });

  console.log(`Promoted ${email} to Platform Super Admin.`);
  console.log(`Active platform admins before this action: ${adminCount}.`);
  console.log('This action is recorded in the audit log. No password was set or changed.');
  await mongoose.disconnect();
  process.exit(0);
} catch (err) {
  console.error('Bootstrap failed:', err instanceof Error ? err.message : err);
  process.exit(6);
}
