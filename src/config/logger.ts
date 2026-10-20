import { pino } from 'pino';
import { config } from './env';

export const logger = pino({
  level: config.logLevel,
  base: undefined,
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'apiKey',
      '*.apiKey',
      'authorization',
      '*.authorization',
      'cookie',
      '*.cookie',
    ],
    censor: '[redacted]',
  },
});
