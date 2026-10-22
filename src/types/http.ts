import { Request } from 'express';
import { Types } from 'mongoose';
import type { PlatformRole } from '../models/user';

export interface SessionUser {
  id: Types.ObjectId;
  email: string;
  name: string;
  role: PlatformRole;
  preferredLanguage: string;
  timezone: string;
}

export interface AuthedRequest extends Request {
  user?: SessionUser;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export type FamilyRole = 'owner' | 'admin' | 'member';
