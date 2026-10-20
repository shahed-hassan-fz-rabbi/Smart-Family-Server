import { Router } from 'express';
import { Types } from 'mongoose';
import { Notification } from '../models/notification';
import { requireAuth } from '../middleware/auth';
import { HttpError } from '../middleware/familyAccess';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 30) || 30, 100);
    const unreadOnly = req.query.unread === 'true';
    const filter: Record<string, unknown> = { userId: req.user!.id };
    if (unreadOnly) filter.readAt = null;
    const [notifications, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ userId: req.user!.id, readAt: null }),
    ]);
    res.json({
      notifications: notifications.map((n) => ({
        id: String(n._id),
        type: n.type,
        title: n.title,
        message: n.message,
        linkPath: n.linkPath,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      unreadCount,
    });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/:id/read', async (req, res, next) => {
  try {
    const result = await Notification.updateOne(
      { _id: req.params.id, userId: req.user!.id },
      { $set: { readAt: new Date() } },
    );
    if (result.matchedCount === 0) throw new HttpError(404, 'Notification not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/read-all', async (req, res) => {
  await Notification.updateMany(
    { userId: req.user!.id, readAt: null },
    { $set: { readAt: new Date() } },
  );
  res.json({ ok: true });
});
