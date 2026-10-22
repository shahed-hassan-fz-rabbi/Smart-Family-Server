import { Router } from 'express';
import { User } from '../models/user';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateProfileSchema } from '../validators/profile';
import { HttpError } from '../middleware/familyAccess';
import { publicUser } from './auth';

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get('/me', async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.id).select('-passwordHash');
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

usersRouter.patch('/me', validate(updateProfileSchema), async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) throw new HttpError(404, 'Account not found');

    const b = req.body;
    if (b.name) user.name = b.name;
    if (b.preferredLanguage) user.preferredLanguage = b.preferredLanguage;
    if (b.timezone) user.timezone = b.timezone;
    if (b.privacy) user.privacy = { ...user.privacy, ...b.privacy };
    if (b.notificationPrefs) user.notificationPrefs = { ...user.notificationPrefs, ...b.notificationPrefs };
    await user.save();
    // publicUser is the fail-closed whitelist serializer — passwordHash (and
    // anything else sensitive) can never reach the client by accident.
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// Account deletion is soft (data retained for audit); membership is removed.
// The session counter is bumped so the deleted account's token stops working.
usersRouter.delete('/me', async (req, res, next) => {
  try {
    await User.updateOne({ _id: req.user!.id }, { $inc: { tokenVersion: 1 }, $set: { deletedAt: new Date() } });
    res.clearCookie('sf_token');
    res.json({ ok: true, message: 'Account deactivated. Contact your family owner to remove family memberships.' });
  } catch (err) {
    next(err);
  }
});
