// Vitest setup: provide placeholder env vars so unit tests can import modules
// without a real MongoDB connection or secrets. These are test-only values.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ??= 'mongodb://localhost:27017/smart-family-test';
process.env.JWT_SECRET ??= 'test-only-secret-0123456789abcdef';
