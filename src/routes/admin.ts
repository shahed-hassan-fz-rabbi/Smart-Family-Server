import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { User, PlatformRole } from '../models/user';
import { Family, FamilyMembership } from '../models/family';
import { Task } from '../models/task';
import { Reminder } from '../models/reminder';
import { AuditLog } from '../models/audit';
import { requireAuth, requireSuperAdmin } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { HttpError } from '../middleware/familyAccess';
import { isDatabaseConnected } from '../db/connect';
import { config } from '../config/env';
import { AuthedRequest } from '../types/http';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireSuperAdmin);

const listSchema = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const idSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const suspendSchema = z.object({ reason: z.string().trim().min(3).max(300) });

function parseListQuery(url: string): z.infer<typeof listSchema> {
  const u = new URL(url, 'http://localhost');
  const raw: Record<string, string> = {};
  for (const k of ['q', 'page', 'limit']) {
    const v = u.searchParams.get(k);
    if (v !== null) raw[k] = v;
  }
  return listSchema.parse(raw);
}

function parseId(raw: string): mongoose.Types.ObjectId {
  const ok = idSchema.safeParse(raw);
  if (!ok.success) throw new HttpError(400, 'Invalid id');
  return new mongoose.Types.ObjectId(raw);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function auditOrThrow(
  req: AuthedRequest,
  action: string,
  targetType: 'user' | 'family' | 'platform',
  targetId: string | null,
  meta: Record<string, unknown>,
): Promise<void> {
  // For privileged actions an audit-write failure must surface (error handler
  // → 500). Privileged changes are never recorded as unlogged.
  await AuditLog.create({
    actorId: new mongoose.Types.ObjectId(req.user!.id),
    actorEmail: req.user!.email,
    action,
    targetType,
    targetId: targetId ? new mongoose.Types.ObjectId(targetId) : null,
    meta,
    ip: req.ip,
  });
}

/** Platform overview metrics — aggregates only, never personal content. */
adminRouter.get('/overview', async (_req, res, next) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const vals = await Promise.all([
      User.countDocuments({ deletedAt: null }),
      User.countDocuments({ deletedAt: null, suspendedAt: { $ne: null } }),
      User.countDocuments({ deletedAt: { $ne: null } }),
      User.countDocuments({ deletedAt: null, role: 'super_admin', suspendedAt: { $eq: null } }),
      Family.countDocuments({}),
      FamilyMembership.countDocuments({}),
      Task.countDocuments({}),
      Reminder.countDocuments({}),
      User.countDocuments({ deletedAt: null, createdAt: { $gte: weekAgo } }),
    ]);
    res.json({
      users: {
        total: vals[0],
        suspended: vals[1],
        deleted: vals[2],
        superAdmins: vals[3],
        newLast7Days: vals[8],
      },
      families: { total: vals[4], memberships: vals[5] },
      activity: { tasks: vals[6], reminders: vals[7] },
    });
  } catch (err) {
    next(err);
  }
});

/** User list for account management — no private family content, no hashes. */
adminRouter.get('/users', async (req, res, next) => {
  try {
    const { q, page, limit } = parseListQuery(req.originalUrl);
    const filter: Record<string, unknown> = { deletedAt: null };
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ name: rx }, { email: rx }];
    }
    const [total, rows] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('name email role suspendedAt suspendReason createdAt lastSeenAt')
        .lean<{
          _id: mongoose.Types.ObjectId;
          name: string;
          email: string;
          role: string;
          suspendedAt?: Date | null;
          suspendReason?: string | null;
          createdAt: Date;
          lastSeenAt?: Date | null;
        }[]>(),
    ]);
    res.json({
      total,
      page,
      limit,
      users: rows.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        role: u.role as PlatformRole,
        suspendedAt: u.suspendedAt ?? null,
        suspendReason: u.suspendReason ?? null,
        createdAt: u.createdAt,
        lastSeenAt: (u as { lastSeenAt?: Date }).lastSeenAt ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Suspend a normal account (reversible). Super-admin accounts cannot be
 * suspended or touched here — they are the platform's last line of control
 * (no accidental loss of the last administrator is possible by construction).
 */
adminRouter.patch('/users/:id/suspend', validate(suspendSchema), async (req, res, next) => {
  try {
    const targetId = parseId(req.params.id);
    const user = await User.findOne({ _id: targetId, deletedAt: null });
    if (!user) throw new HttpError(404, 'Account not found');
    // Strongest protection first: no platform administrator can ever be
    // suspended — even self-suspension of the only existing one.
    if (user.role === 'super_admin') {
      throw new HttpError(403, 'Platform administrator accounts cannot be suspended from the dashboard');
    }
    if (user.suspendedAt) throw new HttpError(409, 'Account is already suspended');

    const reason = req.body.reason as string;
    user.suspendedAt = new Date();
    user.suspendReason = reason;
    user.suspendedBy = req.user!.id;
    await user.save();
    await auditOrThrow(req, 'platform.user.suspended', 'user', String(user._id), {
      email: user.email,
      reason,
    });
    res.json({
      ok: true,
      user: {
        id: String(user._id),
        email: user.email,
        suspendedAt: user.suspendedAt,
        suspendReason: user.suspendReason,
      },
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/users/:id/restore', async (req, res, next) => {
  try {
    const targetId = parseId(req.params.id);
    const user = await User.findOne({ _id: targetId, deletedAt: null });
    if (!user) throw new HttpError(404, 'Account not found');
    if (!user.suspendedAt) throw new HttpError(409, 'Account is not suspended');

    const previousReason = user.suspendReason;
    user.suspendedAt = null;
    user.suspendReason = undefined;
    user.suspendedBy = undefined;
    await user.save();
    await auditOrThrow(req, 'platform.user.restored', 'user', String(user._id), {
      email: user.email,
      previousReason: previousReason ?? null,
    });
    res.json({ ok: true, user: { id: String(user._id), email: user.email, suspendedAt: null } });
  } catch (err) {
    next(err);
  }
});

/** Family list — names, sizes, owners. Read-only; never message content. */
adminRouter.get('/families', async (req, res, next) => {
  try {
    const { q, page, limit } = parseListQuery(req.originalUrl);
    const filter: Record<string, unknown> = {};
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.name = rx;
    }
    const [total, rows] = await Promise.all([
      Family.countDocuments(filter),
      Family.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<{ _id: mongoose.Types.ObjectId; name: string; ownerId: mongoose.Types.ObjectId; createdAt: Date; description?: string }[]>(),
    ]);
    const familyIds = rows.map((f) => f._id);
    const counts = await FamilyMembership.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $match: { familyId: { $in: familyIds } } },
      { $group: { _id: '$familyId', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
    const ownerIds = [...new Set(rows.map((f) => String(f.ownerId)))].map(
      (id) => new mongoose.Types.ObjectId(id),
    );
    const owners = await User.find({ _id: { $in: ownerIds } })
      .select('name email')
      .lean<{ _id: mongoose.Types.ObjectId; name: string; email: string }[]>();
    const ownerMap = new Map(owners.map((o) => [String(o._id), o]));
    res.json({
      total,
      page,
      limit,
      families: rows.map((f) => ({
        id: String(f._id),
        name: f.name,
        description: f.description ?? null,
        createdAt: f.createdAt,
        memberCount: countMap.get(String(f._id)) ?? 0,
        owner: ownerMap.get(String(f.ownerId))
          ? {
              id: String(f.ownerId),
              name: ownerMap.get(String(f.ownerId))!.name,
              email: ownerMap.get(String(f.ownerId))!.email,
            }
          : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Real service health for operations — no secrets, only configured flags. */
adminRouter.get('/services', async (_req, res, next) => {
  try {
    let dbPingMs: number | null = null;
    if (isDatabaseConnected() && mongoose.connection.db) {
      const start = Date.now();
      await mongoose.connection.db.admin().ping();
      dbPingMs = Date.now() - start;
    }
    res.json({
      time: new Date().toISOString(),
      db: { connected: isDatabaseConnected(), pingMs: dbPingMs },
      integrations: {
        gemini: { configured: config.gemini.enabled, model: config.gemini.model },
        livekit: { configured: config.livekit.enabled },
        googleSignIn: { configured: config.google.enabled },
      },
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        environment: config.isProd ? 'production' : 'development',
        memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Immutable audit trail (privileged actions + bootstrap). */
adminRouter.get('/audit', async (req, res, next) => {
  try {
    const { q, page, limit } = parseListQuery(req.originalUrl);
    const filter: Record<string, unknown> = {};
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.action = rx;
    }
    const [total, rows] = await Promise.all([
      AuditLog.countDocuments(filter),
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<{ _id: mongoose.Types.ObjectId; actorEmail?: string; action: string; targetType?: string; targetId?: mongoose.Types.ObjectId | null; meta?: Record<string, unknown>; ip?: string; createdAt: Date }[]>(),
    ]);
    res.json({
      total,
      page,
      limit,
      entries: rows.map((a) => ({
        id: String(a._id),
        actorEmail: a.actorEmail ?? 'bootstrap-script',
        action: a.action,
        targetType: a.targetType ?? null,
        targetId: a.targetId ? String(a.targetId) : null,
        meta: a.meta ?? null,
        ip: a.ip ?? null,
        createdAt: a.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Platform administrators list (read-only, for safe handover planning). */
adminRouter.get('/admins', async (_req, res, next) => {
  try {
    const rows = await User.find({ role: 'super_admin', deletedAt: null })
      .select('name email suspendedAt createdAt')
      .sort({ createdAt: 1 })
      .lean<{ _id: mongoose.Types.ObjectId; name: string; email: string; suspendedAt?: Date | null; createdAt: Date }[]>();
    res.json({
      admins: rows.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        suspendedAt: u.suspendedAt ?? null,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

