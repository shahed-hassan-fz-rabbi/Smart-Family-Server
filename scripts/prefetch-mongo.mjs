/* Pre-fetches the MongoDB binary for mongodb-memory-server (test infrastructure only). */
import 'dotenv/config';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/smart-family-test';
process.env.JWT_SECRET ||= 'prefetch-only';

const { MongoMemoryServer } = await import('mongodb-memory-server');
console.log('Ensuring MongoDB binary is available (this downloads once, then is cached)...');
const mongod = await MongoMemoryServer.create();
console.log('MongoDB ready at', mongod.getUri());
await mongod.stop();
console.log('Binary cached successfully. You can now run: npm test');
