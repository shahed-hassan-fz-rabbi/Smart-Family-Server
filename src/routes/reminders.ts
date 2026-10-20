import { Router } from 'express';
import { Types } from 'mongoose';
import { Reminder } from '../models/reminder';
import { requireAuth } from '../middleware/auth';
import { requireFamilyMembership, HttpError } from '../middleware/familyAccess';
import { validate } from '../middleware/validate';
import { reminderSchema, updateReminderSchema } from '../validators/profile';

export const remindersRouter = Router();

remindersRouter.use(requireAuth);

remindersRouter.get('/', async (req, res, next) => {
  try {
    const familyId = req.query.familyId as string | undefined;
    if (!familyId) throw new HttpError(400, 'familyId query parameter is required');
    const { familyId: fid } = await requireFamilyMembership(req, familyId);
    const scope = req.query.scope as string | undefined;
    const filter: Record<string, unknown> = { familyId: fid };
    if (scope === 'mine') {
      filter.$or = [{ recipientIds: req.user!.id }, { remindFamily: true }, { createdById: req.user!.id }];
    } else if (scope === 'upcoming') {
      filter.dueAt = { $gte: new Date() };
    }
    const reminders = await Reminder.find(filter).sort({ dueAt: 1 }).limit(200).lean();
    res.json({
      reminders: reminders.map((r) => ({
        id: String(r._id),
        title: r.title,
        notes: r.notes,
        dueAt: r.dueAt,
        recurrence: r.recurrence,
        status: r.status,
        remindFamily: r.remindFamily,
        isMine: String(r.createdById) === String(req.user!.id),
        createdBy: r.createdBy,
        taskId: r.taskId ? String(r.taskId) : null,
        eventId: r.eventId ? String(r.eventId) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

remindersRouter.post('/', validate(reminderSchema), async (req, res, next) => {
  try {
    const { familyId } = await requireFamilyMembership(req, req.body.familyId);
    const reminder = await Reminder.create({
      familyId,
      title: req.body.title,
      notes: req.body.notes,
      dueAt: new Date(req.body.dueAt),
      remindFamily: req.body.remindFamily,
      recipientIds: req.body.remindFamily ? [] : req.body.recipientIds.map((r: string) => new Types.ObjectId(r)),
      recurrence: req.body.recurrence,
      createdById: req.user!.id,
      taskId: req.body.taskId,
      eventId: req.body.eventId,
    });
    res.status(201).json({ reminder: { id: String(reminder._id), title: reminder.title } });
  } catch (err) {
    next(err);
  }
});

remindersRouter.patch('/:reminderId', validate(updateReminderSchema), async (req, res, next) => {
  try {
    const body = req.body as { familyId?: string };
    if (!body.familyId) throw new HttpError(400, 'familyId is required for reminder updates');
    const { familyId } = await requireFamilyMembership(req, body.familyId);
    const reminder = await Reminder.findOne({ _id: req.params.reminderId, familyId });
    if (!reminder) throw new HttpError(404, 'Reminder not found');
    // Reminders can be modified by their creator or by a recipient.
    const isCreator = String(reminder.createdById) === String(req.user!.id);
    const isRecipient = reminder.recipientIds.some((r) => r.toString() === String(req.user!.id));
    if (!isCreator && !isRecipient && !reminder.remindFamily) {
      throw new HttpError(403, 'Only the creator or recipients can modify this reminder');
    }
    const fields = ['title', 'notes', 'remindFamily', 'recurrence'] as const;
    for (const f of fields) {
      if (req.body[f] !== undefined) (reminder as unknown as Record<string, unknown>)[f] = req.body[f];
    }
    if (req.body.dueAt) reminder.dueAt = new Date(req.body.dueAt);
    if (req.body.recipientIds) {
      reminder.recipientIds = req.body.recipientIds.map((r: string) => new Types.ObjectId(r));
    }
    if (req.body.status) reminder.status = req.body.status;
    await reminder.save();
    res.json({ reminder: { id: String(reminder._id), status: reminder.status } });
  } catch (err) {
    next(err);
  }
});

remindersRouter.delete('/:reminderId', async (req, res, next) => {
  try {
    const familyIdRaw = (req.query.familyId ?? req.body?.familyId) as string | undefined;
    if (!familyIdRaw) throw new HttpError(400, 'familyId query parameter is required');
    const { familyId } = await requireFamilyMembership(req, familyIdRaw);
    const reminder = await Reminder.findOne({ _id: req.params.reminderId, familyId });
    if (!reminder) throw new HttpError(404, 'Reminder not found');
    if (String(reminder.createdById) !== String(req.user!.id)) {
      throw new HttpError(403, 'Only the reminder creator can delete it');
    }
    await reminder.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
