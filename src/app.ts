import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config/env';
import { errorHandler } from './middleware/validate';
import { isDatabaseConnected } from './db/connect';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { familiesRouter } from './routes/families';
import { tasksRouter } from './routes/tasks';
import { calendarRouter } from './routes/calendar';
import { remindersRouter } from './routes/reminders';
import { notificationsRouter } from './routes/notifications';
import { aiRouter } from './routes/ai';
import { conversationsRouter } from './routes/conversations';
import { callsRouter } from './routes/calls';
import { safetyRouter } from './routes/safety';
import { logger } from './config/logger';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow same-origin/no-origin (health checks, curl) and configured origins.
        if (!origin) {
          callback(null, true);
          return;
        }
        const normalized = origin.replace(/\/+$/, '');
        if (config.corsOrigins.includes(normalized)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(
    morgan(config.isProd ? 'combined' : 'dev', {
      stream: { write: (line) => logger.info(line.trim()) },
    }),
  );

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/me'),
  });
  app.use('/api/auth', authLimiter);

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  app.use('/api', apiLimiter);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'smart-family-server',
      dbConnected: isDatabaseConnected(),
      aiConfigured: config.gemini.enabled,
      livekitConfigured: config.livekit.enabled,
      time: new Date().toISOString(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/families', familiesRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/calendar', calendarRouter);
  app.use('/api/reminders', remindersRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api', safetyRouter); // mounted at root for family-scoped safety endpoints

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });

  app.use(errorHandler);
  return app;
}
