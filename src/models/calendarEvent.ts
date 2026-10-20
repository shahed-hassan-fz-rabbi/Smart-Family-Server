import { Schema, model, Document, Types } from 'mongoose';

export interface ICalendarEvent extends Document<Types.ObjectId> {
  familyId: Types.ObjectId;
  title: string;
  description?: string;
  location?: string;
  startAt: Date;
  endAt: Date;
  createdById: Types.ObjectId;
  participantIds: Types.ObjectId[];
  category: 'appointment' | 'family_event' | 'personal' | 'other';
  createdBy: 'user' | 'ai';
}

const eventSchema = new Schema<ICalendarEvent>(
  {
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, maxlength: 2000 },
    location: { type: String, maxlength: 240 },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    participantIds: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
    category: { type: String, enum: ['appointment', 'family_event', 'personal', 'other'], default: 'other' },
    createdBy: { type: String, enum: ['user', 'ai'], default: 'user' },
  },
  { timestamps: true },
);

eventSchema.index({ familyId: 1, startAt: 1 });

export const CalendarEvent = model<ICalendarEvent>('CalendarEvent', eventSchema);
