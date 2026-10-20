import { Schema, model, Document, Types } from 'mongoose';

export type CallMode = 'audio' | 'video';
export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'declined';

export interface ICallSession extends Document<Types.ObjectId> {
  familyId: Types.ObjectId;
  conversationId?: Types.ObjectId;
  mode: CallMode;
  status: CallStatus;
  initiatorId: Types.ObjectId;
  participants: { userId: Types.ObjectId; joinedAt?: Date; leftAt?: Date }[];
  startedAt: Date;
  endedAt?: Date;
}

export interface IEmergencyContact extends Document<Types.ObjectId> {
  familyId: Types.ObjectId;
  createdById: Types.ObjectId;
  name: string;
  relationship: string;
  phone: string;
  altPhone?: string;
  notes?: string;
  isPrimary: boolean;
}

export interface IFamilyUpdate extends Document<Types.ObjectId> {
  familyId: Types.ObjectId;
  authorId: Types.ObjectId;
  content: string;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const callSchema = new Schema<ICallSession>({
  familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
  conversationId: { type: Schema.Types.ObjectId, ref: 'ChatConversation' },
  mode: { type: String, enum: ['audio', 'video'], required: true },
  status: { type: String, enum: ['ringing', 'active', 'ended', 'missed', 'declined'], default: 'ringing', index: true },
  initiatorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  participants: [
    {
      _id: false,
      userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      joinedAt: { type: Date },
      leftAt: { type: Date },
    },
  ],
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
});

const emergencyContactSchema = new Schema<IEmergencyContact>(
  {
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    relationship: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    altPhone: { type: String, trim: true, maxlength: 30 },
    notes: { type: String, maxlength: 500 },
    isPrimary: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const familyUpdateSchema = new Schema<IFamilyUpdate>(
  {
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 },
    pinned: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const CallSession = model<ICallSession>('CallSession', callSchema);
export const EmergencyContact = model<IEmergencyContact>('EmergencyContact', emergencyContactSchema);
export const FamilyUpdate = model<IFamilyUpdate>('FamilyUpdate', familyUpdateSchema);
