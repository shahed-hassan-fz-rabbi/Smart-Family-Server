import { Schema, model, Document, Types } from 'mongoose';

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly';

export interface IReminder extends Document<Types.ObjectId> {
  familyId: Types.ObjectId;
  title: string;
  notes?: string;
  dueAt: Date;
  remindFamily: boolean;
  recipientIds: Types.ObjectId[];
  recurrence: Recurrence;
  status: 'pending' | 'completed' | 'dismissed';
  lastFiredAt?: Date;
  createdById: Types.ObjectId;
  taskId?: Types.ObjectId;
  eventId?: Types.ObjectId;
  createdBy: 'user' | 'ai';
}

const reminderSchema = new Schema<IReminder>(
  {
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    notes: { type: String, maxlength: 1000 },
    dueAt: { type: Date, required: true, index: true },
    remindFamily: { type: Boolean, default: false },
    recipientIds: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
    recurrence: { type: String, enum: ['none', 'daily', 'weekly', 'monthly'], default: 'none' },
    status: { type: String, enum: ['pending', 'completed', 'dismissed'], default: 'pending', index: true },
    lastFiredAt: { type: Date },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
    eventId: { type: Schema.Types.ObjectId, ref: 'CalendarEvent' },
    createdBy: { type: String, enum: ['user', 'ai'], default: 'user' },
  },
  { timestamps: true },
);

reminderSchema.index({ familyId: 1, status: 1, dueAt: 1 });

export const Reminder = model<IReminder>('Reminder', reminderSchema);
