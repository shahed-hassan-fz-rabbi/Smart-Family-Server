import http from 'http';
import { createApp } from './app';
import { config } from './config/env';
import { logger } from './config/logger';
import { connectDatabase, disconnectDatabase } from './db/connect';
import { initSocket } from './socket';
import { setIO } from './lib/realtime';
import { startReminderScheduler } from './services/reminderScheduler';

async function main(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);
  const io = initSocket(server);
  setIO(io);
  startReminderScheduler();

  server.listen(config.port, () => {
    logger.info(`Smart Family server listening on port ${config.port} (${config.env})`);
    logger.info(`CORS origins: ${config.corsOrigins.join(', ')}`);
    if (!config.gemini.enabled) {
      logger.warn('GEMINI_API_KEY missing — the AI assistant will report it is not configured.');
    }
    if (!config.livekit.enabled) {
      logger.warn('LiveKit credentials missing — call tokens cannot be issued until configured.');
    }
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Server failed to start');
  process.exit(1);
});
