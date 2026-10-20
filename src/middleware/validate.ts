import { NextFunction, Response } from 'express';
import { ZodError, ZodTypeAny } from 'zod';
import { HttpError } from './familyAccess';

type Source = 'body' | 'query' | 'params';

/** Validates a request source against a Zod schema and replaces it with parsed output. */
export function validate(schema: ZodTypeAny, source: Source = 'body') {
  return (req: import('express').Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(new HttpError(400, 'Invalid request data', result.error.flatten()));
      return;
    }
    Object.defineProperty(req, source, {
      value: result.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}

/** Central error handler — hides internals in production. */
export function errorHandler(
  err: unknown,
  _req: unknown,
  res: Response,
  _next: unknown,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request data', details: err.flatten() });
    return;
  }
  // Mongoose duplicate key
  const e = err as { code?: number; keyValue?: Record<string, unknown> };
  if (e?.code === 11000) {
    res.status(409).json({ error: 'Resource already exists', fields: e.keyValue });
    return;
  }
  const message = process.env.NODE_ENV === 'production' ? 'Internal server error' : String((err as Error)?.stack ?? err);
  res.status(500).json({ error: message });
}
