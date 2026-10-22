import cron from 'node-cron';
import { Types } from 'mongoose';
import { Reminder } from '../models/reminder';
import { createNotification } from './notification';
import { expireStaleRingingCalls } from './callSweeper';
import { emitToUsers } from '../lib/realtime';
import { FamilyMembership } from '../models/family';
import { logger } from '../config/logger';

/**
 * Server-side reminder scheduling. Runs in-process via node-cron; suitable for
 * a single Render instance. Behaviour on restarts: any pending reminder whose
 * dueAt has already passed is fired immediately at boot (once), then advanced
 * or closed according to recurrence — so reminders are not silently lost.
 *
 * Delivery is in-app (notification + socket event). No email/push is claimed.
 */
let started = false;

export function startReminderScheduler(): void {
  if (started) return;
  started = true;

  cron.schedule('* * * * *', () => {
    void processDueReminders();
    // Reliability sweep: unanswered calls age into `missed` even when nobody
    // is currently hitting the call routes.
    void expireStaleRingingCalls();
  });
  logger.info('Reminder scheduler started (every minute, in-process)');

  // Clean up calls that went stale while the server was down.
  void expireStaleRingingCalls();
}

export async function processDueReminders(): Promise<number> {
  const now = new Date();
  // Small lookahead keeps "why didn't it fire?" gaps away without double firing.
  const due = await Reminder.find({
    status: 'pending',
    dueAt: { $lte: new Date(now.getTime() + 15_000) },
    $or: [{ lastFiredAt: null }, { lastFiredAt: { $lt: new Date(now.getTime() - 55_000) } }],
  }).limit(100);

  let fired = 0;
  for (const reminder of due) {
    let recipients: Types.ObjectId[];
    if (reminder.remindFamily) {
      const memberships = await FamilyMembership.find({ familyId: reminder.familyId }).lean();
      recipients = memberships.map((m) => m.userId as Types.ObjectId);
    } else if (reminder.recipientIds.length) {
      recipients = reminder.recipientIds;
    } else {
      recipients = [reminder.createdById as Types.ObjectId];
    }

    for (const userId of recipients) {
      await createNotification({
        userId,
        familyId: reminder.familyId,
        type: 'reminder_due',
        title: `Reminder: ${reminder.title}`,
        message: reminder.notes,
        linkPath: '/reminders',
        refType: 'reminder',
        refId: reminder._id,
        dedupeKey: `reminder-${reminder._id}-${reminder.dueAt.toISOString()}-${userId}`,
      });
    }

    if (recipients.length) {
      emitToUsers(recipients, 'reminder:due', {
        reminderId: reminder._id.toString(),
        title: reminder.title,
        dueAt: reminder.dueAt.toISOString(),
      });
    }

    fired++;
    reminder.lastFiredAt = now;

    if (reminder.recurrence !== 'none') {
      reminder.dueAt = nextOccurrence(reminder.dueAt, reminder.recurrence);
      await reminder.save(); // stays pending for the next cycle
      logger.debug({ reminderId: reminder._id, next: reminder.dueAt }, 'Recurring reminder advanced');
    } else {
      reminder.status = 'completed';
      await reminder.save();
    }
  }
  return fired;
}

export function nextOccurrence(from: Date, recurrence: 'daily' | 'weekly' | 'monthly'): Date {
  const next = new Date(from);
  switch (recurrence) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'monthly': {
      // Preserve the day-of-month where the target month allows it (avoid JS overflow, e.g. Jan 31 → Mar 3).
      const originalDay = next.getDate();
      next.setMonth(next.getMonth() + 1);
      if (next.getDate() !== originalDay) {
        next.setDate(0); // clamp to last day of the target month
      }
      break;
    }
  }
  return next;
}
