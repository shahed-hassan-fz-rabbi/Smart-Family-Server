import { Router } from 'express';
import { Types } from 'mongoose';
import { CalendarEvent } from '../models/calendarEvent';
import { requireAuth } from '../middleware/auth';
import { requireFamilyMembership, HttpError } from '../middleware/familyAccess';
import { validate } from '../middleware/validate';
import { createEventSchema, updateEventSchema, listEventsQuery } from '../validators/content';
import { createNotification } from '../services/notification';

export const calendarRouter = Router();

calendarRouter.use(requireAuth);

calendarRouter.get('/events', validate(listEventsQuery, 'query'), async (req, res, next) => {
  try {
    const { familyId } = await requireFamilyMembership(req, req.query.familyId as string);
    const filter: Record<string, unknown> = { familyId };
    if (req.query.from || req.query.to) {
      filter.startAt = {
        ...(req.query.from ? { $gte: new Date(req.query.from as string) } : {}),
        ...(req.query.to ? { $lte: new Date(req.query.to as string) } : {}),
      };
    }
    const events = await CalendarEvent.find(filter)
      .sort({ startAt: 1 })
      .limit(200)
      .populate('participantIds', 'name')
      .lean();
    res.json({
      events: events.map((e) => ({
        id: String(e._id),
        title: e.title,
        description: e.description,
        location: e.location,
        startAt: e.startAt,
        endAt: e.endAt,
        category: e.category,
        createdBy: e.createdBy,
        participants: (e.participantIds as unknown as { _id: Types.ObjectId; name: string }[]).map((p) => ({
          id: String(p._id),
          name: p.name,
        })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

calendarRouter.post('/events', validate(createEventSchema), async (req, res, next) => {
  try {
    const { familyId } = await requireFamilyMembership(req, req.body.familyId);
    const participants = (req.body.participantIds ?? []).length
      ? req.body.participantIds
      : [String(req.user!.id)];
    for (const p of participants) {
      const membership = await requireFamilyMembership({ user: { id: new Types.ObjectId(p) } } as never, String(familyId));
      void membership;
    }
    const event = await CalendarEvent.create({
      familyId,
      title: req.body.title,
      description: req.body.description,
      location: req.body.location,
      startAt: new Date(req.body.startAt),
      endAt: new Date(req.body.endAt),
      createdById: req.user!.id,
      participantIds: participants.map((p: string) => new Types.ObjectId(p)),
      category: req.body.category,
    });
    // Notify invited participants (excluding the creator)
    for (const p of participants) {
      if (p !== String(req.user!.id)) {
        await createNotification({
          userId: new Types.ObjectId(p),
          familyId,
          type: 'event_change',
          title: `Calendar event: ${event.title}`,
          message: `${req.user!.name} added an event on ${event.startAt.toDateString()}`,
          linkPath: '/calendar',
          refType: 'event',
          refId: event._id as Types.ObjectId,
          dedupeKey: `event-${event._id}-${p}`,
        });
      }
    }
    res.status(201).json({ event: { id: String(event._id), title: event.title } });
  } catch (err) {
    next(err);
  }
});

calendarRouter.patch('/events/:eventId', validate(updateEventSchema), async (req, res, next) => {
  try {
    const body = req.body as { familyId?: string };
    if (!body.familyId) throw new HttpError(400, 'familyId is required for event updates');
    const { familyId } = await requireFamilyMembership(req, body.familyId);
    const event = await CalendarEvent.findOne({ _id: req.params.eventId, familyId });
    if (!event) throw new HttpError(404, 'Event not found');
    if (String(event.createdById) !== String(req.user!.id)) {
      throw new HttpError(403, 'Only the event creator can edit it');
    }
    const startChanged = req.body.startAt && new Date(req.body.startAt).getTime() !== event.startAt.getTime();
    if (req.body.title) event.title = req.body.title;
    if (req.body.description !== undefined) event.description = req.body.description;
    if (req.body.location !== undefined) event.location = req.body.location;
    if (req.body.startAt) event.startAt = new Date(req.body.startAt);
    if (req.body.endAt) event.endAt = new Date(req.body.endAt);
    if (req.body.category) event.category = req.body.category;
    await event.save();

    if (startChanged || req.body.title) {
      for (const p of event.participantIds) {
        if (p.toString() !== String(req.user!.id)) {
          await createNotification({
            userId: p,
            familyId,
            type: 'event_change',
            title: `Event updated: ${event.title}`,
            message: `New time: ${event.startAt.toLocaleString()}`,
            linkPath: '/calendar',
            refType: 'event',
            refId: event._id as Types.ObjectId,
            dedupeKey: `event-change-${event._id}-${Date.now()}-${p}`,
          });
        }
      }
    }
    res.json({ event: { id: String(event._id) } });
  } catch (err) {
    next(err);
  }
});

calendarRouter.delete('/events/:eventId', async (req, res, next) => {
  try {
    const familyIdRaw = (req.query.familyId ?? req.body?.familyId) as string | undefined;
    if (!familyIdRaw) throw new HttpError(400, 'familyId query parameter is required');
    const { familyId } = await requireFamilyMembership(req, familyIdRaw);
    const event = await CalendarEvent.findOne({ _id: req.params.eventId, familyId });
    if (!event) throw new HttpError(404, 'Event not found');
    if (String(event.createdById) !== String(req.user!.id)) {
      throw new HttpError(403, 'Only the event creator can delete it');
    }
    await event.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Conflict detection: overlapping events for the same family, optionally scoped to a participant overlap. */
calendarRouter.get('/events/conflicts', async (req, res, next) => {
  try {
    const familyIdRaw = req.query.familyId as string | undefined;
    if (!familyIdRaw) throw new HttpError(400, 'familyId query parameter is required');
    const { familyId } = await requireFamilyMembership(req, familyIdRaw);
    const events = await CalendarEvent.find({ familyId })
      .sort({ startAt: 1 })
      .limit(300)
      .lean();
    const conflicts: { a: string; b: string; between: string }[] = [];
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const a = events[i];
        const b = events[j];
        const overlaps = a.startAt < b.endAt && b.startAt < a.endAt;
        const shared = (a.participantIds ?? []).some((pid) => (b.participantIds ?? []).some((p) => p.equals(pid as Types.ObjectId)));
        if (overlaps && shared) {
          conflicts.push({ a: String(a._id), b: String(b._id), between: `${a.title} ↔ ${b.title}` });
        }
      }
    }
    res.json({ conflicts });
  } catch (err) {
    next(err);
  }
});
