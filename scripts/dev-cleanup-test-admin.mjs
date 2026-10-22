/**
 * One-off dev cleanup: the e2e verification of the Platform Admin system
 * created a TEST super admin (key-admin-*@example.com, weak test password) in
 * the developer's database. Leaving a weak-password privileged account there
 * would be a real security risk, so this returns it to role 'user' and records
 * an explicit audit entry. NOT part of the platform (there is still no demote
 * command in the admin product surface — rotation is documented
 * instead).
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const email = (await import('node:fs')).readFileSync('.admin-test-email', 'utf8').trim().replace(/^EMAIL=/, '');

if (!process.env.MONGODB_URI) {
  console.error('Refused: MONGODB_URI is not set.');
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI);
try {
  const db = mongoose.connection.db;
  const user = await db.collection('users').findOne({ email, deletedAt: null });
  if (!user) {
    console.error(`No live account for ${email} found.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  await db.collection('users').updateOne({ _id: user._id }, { $set: { role: 'user', updatedAt: new Date() } });
  await db.collection('auditlogs').insertOne({
    actorId: user._id,
    actorEmail: email,
    action: 'platform.admin.devCleanupDemoted',
    targetType: 'user',
    targetId: user._id,
    meta: {
      email,
      note: 'e2e verification test admin returned to role user so no weak-password privileged account remains',
      testOnly: true,
    },
    createdAt: new Date(),
  });
  console.log(`Cleanup done: ${email} is back to role "user" and the action is audited.`);
  await mongoose.disconnect();
  process.exit(0);
} catch (err) {
  console.error('Cleanup failed:', err instanceof Error ? err.message : err);
  process.exit(2);
}
