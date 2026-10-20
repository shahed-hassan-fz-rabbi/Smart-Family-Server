/**
 * Boot smoke test: starts an in-memory MongoDB, boots the BUILT server
 * (dist/index.js — the exact artifact Render runs), waits for /api/health,
 * and reports the result honestly. Requires `npm run build` first.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri('smart-family-boot-test');
process.env.JWT_SECRET = 'boot-smoke-secret-0123456789abcdef';
process.env.NODE_ENV = 'development';
process.env.PORT = '4777';
process.env.FRONTEND_URL = 'http://localhost:3000';

await import('../dist/index.js');

for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch('http://127.0.0.1:4777/api/health');
    const body = await res.json();
    console.log('HEALTH', res.status, JSON.stringify(body));
    if (body.dbConnected !== true) {
      console.error('FAILED: server booted but database is not connected');
      await mongod.stop();
      process.exit(1);
    }
    console.log('BOOT SMOKE TEST PASSED — built server listens, connects, and reports health');
    await mongod.stop();
    process.exit(0);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
console.error('FAILED: server did not become healthy within 15 seconds');
await mongod.stop();
process.exit(1);
