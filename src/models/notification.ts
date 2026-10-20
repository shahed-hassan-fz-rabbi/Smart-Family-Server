import { Schema, model, Document, Types } from 'mongoose';

export type NotificationType =
  | 'task_assigned'
  | 'task_completed'
  | 'reminder_due'
  | 'family_invitation'
  | 'event_change'
  | 'family_update'
  | 'chat_message'
  | 'call_incoming'
  | 'system';

export interface INotification extends Document<Types.ObjectId> {
  userId: Types.ObjectId;
  familyId?: Types.ObjectId;
  type: NotificationType;
  title: string;
  message?: string;
  linkPath?: string;
  refType?: string;
  refId?: Types.ObjectId;
  readAt?: Date;
  dedupeKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', index: true },
    type: { type: String, enum: ['task_assigned', 'task_completed', 'reminder_due', 'family_invitation', 'event_change', 'family_update', 'chat_message', 'call_incoming', 'system'], required: true },
    title: { type: String, required: true, maxlength: 160 },
    message: { type: String, maxlength: 500 },
    linkPath: { type: String, maxlength: 240 },
    refType: { type: String },
    refId: { type: Schema.Types.ObjectId },
    readAt: { type: Date, default: null },
    dedupeKey: { type: String },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
// Prevent duplicate notifications per user for the same event.
notificationSchema.index({ dedupeKey: 1, userId: 1 }, { unique: true, sparse: true });

export const Notification = model<INotification>('Notification', notificationSchema);
