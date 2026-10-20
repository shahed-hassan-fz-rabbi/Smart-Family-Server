import mongoose from 'mongoose';
import { config } from '../config/env';
import { logger } from '../config/logger';

let connected = false;

export async function connectDatabase(): Promise<void> {
  if (connected) return;
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri);
  connected = true;
  logger.info('Connected to MongoDB');
}

export async function disconnectDatabase(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
