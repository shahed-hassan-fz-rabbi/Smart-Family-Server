import { Types } from 'mongoose';
import { CallSession } from '../models/safety';
import { createNotification } from './notification';
import { emitToUsers } from '../lib/realtime';

/** How long an unanswered call keeps ringing before it is marked missed. */
const RING_TIMEOUT_MS = 60_000;

/**
 * Marks stale `ringing` calls as `missed`. Called lazily on call-related
 * routes (so a single-instance dev/prod deploy cleans itself on traffic) and
 * from the reminder scheduler cron (so it also runs with zero traffic).
 */
export async function expireStaleRingingCalls(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RING_TIMEOUT_MS);
  const stale = await CallSession.find({ status: 'ringing', startedAt: { $lt: cutoff } }).limit(200);

  for (const call of stale) {
    call.status = 'missed';
    call.endedAt = now;
    await call.save();

    const calleeIds = call.participants
      .map((p) => p.userId)
      .filter((uid) => String(uid) !== String(call.initiatorId));
    emitToUsers(calleeIds.map((uid) => String(uid)), 'call:missed', { callId: String(call._id) });

    for (const userId of calleeIds) {
      await createNotification({
        userId: new Types.ObjectId(String(userId)),
        familyId: call.familyId,
        type: 'call_missed',
        title: `Missed ${call.mode} call`,
        linkPath: `/calls/${String(call._id)}`,
        refType: 'call',
        refId: call._id as Types.ObjectId,
        dedupeKey: `call-missed-${call._id}-${String(userId)}`,
      });
    }
  }

  return stale.length;
}
