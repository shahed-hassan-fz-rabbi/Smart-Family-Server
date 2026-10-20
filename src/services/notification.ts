import { Types } from 'mongoose';
import { Notification } from '../models/notification';
import { emitToUsers } from '../lib/realtime';
import { logger } from '../config/logger';

export interface CreateNotificationInput {
  userId: Types.ObjectId;
  familyId?: Types.ObjectId;
  type: string;
  title: string;
  message?: string;
  linkPath?: string;
  refType?: string;
  refId?: Types.ObjectId;
  dedupeKey?: string;
}

/**
 * Creates an in-app notification and delivers it over Socket.IO when the user
 * is connected. Email delivery is not implemented; do not claim it.
 */
export async function createNotification(input: CreateNotificationInput): Promise<void> {
  try {
    const notification = await Notification.create({
      userId: input.userId,
      familyId: input.familyId,
      type: input.type,
      title: input.title,
      message: input.message,
      linkPath: input.linkPath,
      refType: input.refType,
      refId: input.refId,
      dedupeKey: input.dedupeKey,
    });
    emitToUsers([input.userId], 'notification:new', {
      _id: notification._id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      linkPath: notification.linkPath,
      createdAt: notification.createdAt,
    });
  } catch (err) {
    // Duplicate dedupeKey is expected and benign.
    const code = (err as { code?: number }).code;
    if (code !== 11000) {
      logger.error({ err }, 'Failed to create notification');
    }
  }
}

const EMAIL_IMPLEMENTED = false;

export function isEmailDeliveryImplemented(): boolean {
  return EMAIL_IMPLEMENTED;
}
