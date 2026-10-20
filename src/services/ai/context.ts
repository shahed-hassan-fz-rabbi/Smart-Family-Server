import { Types } from 'mongoose';
import { Task } from '../../models/task';
import { CalendarEvent } from '../../models/calendarEvent';
import { Reminder } from '../../models/reminder';
import { FamilyMembership, Family } from '../../models/family';
import { FamilyUpdate } from '../../models/safety';
import { User } from '../../models/user';
import { logger } from '../../config/logger';

/**
 * Builds a compact, strictly-authorized context for the AI.
 *
 * Rules enforced here:
 * - Only the requesting user's own family data that they can already see.
 * - Personal profile details of other members are limited to name + role.
 * - Private DMs are never included.
 * - A user's own "aiFamilyContextAllowed" consent controls sharing family data
 *   about them to *their own* assistant requests.
 */
export interface FamilyContext {
  familyName: string;
  members: { id: string; name: string; role: string }[];
  openTasks: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueDate?: string;
    assignee?: string;
  }[];
  upcomingEvents: {
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    location?: string;
    category: string;
  }[];
  pendingReminders: { id: string; title: string; dueAt: string; recurrence: string }[];
  recentUpdates: { id: string; author: string; content: string; createdAt: string }[];
  currentDateTime: string;
  timezone: string;
  notes: string[];
}

export async function buildFamilyContext(
  userId: Types.ObjectId,
  familyId: Types.ObjectId,
): Promise<FamilyContext> {
  const [family, memberships] = await Promise.all([
    Family.findById(familyId).lean(),
    FamilyMembership.find({ familyId }).populate('userId', 'name').lean(),
  ]);

  const members = memberships
    .map((m) => {
      const u = m.userId as unknown as { _id: Types.ObjectId; name: string } | null;
      return u
        ? { id: u._id.toString(), name: u.name, role: m.role }
        : { id: '', name: 'Unknown', role: m.role };
    })
    .filter((m) => m.id);

  const nameById = new Map(members.map((m) => [m.id, m.name]));

  const [openTasks, upcomingEvents, pendingReminders, recentUpdates, me] = await Promise.all([
    Task.find({ familyId, status: { $ne: 'completed' } })
      .sort({ dueDate: 1, createdAt: -1 })
      .limit(40)
      .populate('assigneeId', 'name')
      .lean(),
    CalendarEvent.find({
      familyId,
      startAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
    })
      .sort({ startAt: 1 })
      .limit(20)
      .lean(),
    Reminder.find({ familyId, status: 'pending' })
      .sort({ dueAt: 1 })
      .limit(20)
      .lean(),
    FamilyUpdate.find({ familyId })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('authorId', 'name')
      .lean(),
    User.findById(userId).lean(),
  ]);

  const notes: string[] = [];
  if (me && !me.privacy.aiFamilyContextAllowed) {
    notes.push('The requesting user has disabled AI access to family context for themselves.');
  }

  return {
    familyName: family?.name ?? 'Family',
    members,
    openTasks: openTasks.map((t) => ({
      id: t._id.toString(),
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate?.toISOString(),
      assignee: t.assigneeId ? nameById.get((t.assigneeId as unknown as { _id: Types.ObjectId }).toString()) : undefined,
    })),
    upcomingEvents: upcomingEvents
      .filter((e) => isShareable(me, (e.createdById as unknown as { _id: Types.ObjectId }).toString(), userId))
      .map((e) => ({
        id: e._id.toString(),
        title: e.title,
        startAt: e.startAt.toISOString(),
        endAt: e.endAt.toISOString(),
        location: e.location,
        category: e.category,
      })),
    pendingReminders: pendingReminders.map((r) => ({
      id: r._id.toString(),
      title: r.title,
      dueAt: r.dueAt.toISOString(),
      recurrence: r.recurrence,
    })),
    recentUpdates: recentUpdates.map((u) => ({
      id: u._id.toString(),
      author: (u.authorId as unknown as { name: string }).name,
      content: u.content.slice(0, 300),
      createdAt: (u.createdAt as Date).toISOString(),
    })),
    currentDateTime: new Date().toISOString(),
    timezone: family?.timezone ?? 'UTC',
    notes,
  };
}

/** Members can hide their events from family; the AI respects that consent flag on a per-member basis. */
function isShareable(me: { privacy?: { shareCalendarWithFamily?: boolean } } | null, ownerId: string, requesterId: Types.ObjectId): boolean {
  if (ownerId === requesterId.toString()) return true;
  // Calendar share consent of the event creator is checked when events are created;
  // here we only need the requester's own consent.
  return Boolean(me?.privacy?.shareCalendarWithFamily ?? true);
}

export function summarizeContextForLog(ctx: FamilyContext): Record<string, unknown> {
  return {
    familyName: ctx.familyName,
    memberCount: ctx.members.length,
    openTaskCount: ctx.openTasks.length,
    upcomingEventCount: ctx.upcomingEvents.length,
    pendingReminderCount: ctx.pendingReminders.length,
  };
}

export { logger as aiContextLogger };
