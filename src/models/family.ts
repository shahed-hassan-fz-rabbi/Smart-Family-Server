import { Schema, model, Document, Types } from 'mongoose';
import { FamilyRole } from './user';

export interface IFamily extends Document<Types.ObjectId> {
  name: string;
  ownerId: Types.ObjectId;
  description?: string;
  timezone: string;
}

export interface IFamilyMembership extends Document<Types.ObjectId> {
  familyId: Types.ObjectId;
  userId: Types.ObjectId;
  role: FamilyRole;
  nickname?: string;
}

export interface IFamilyInvitation extends Document<Types.ObjectId> {
  familyId: Types.ObjectId;
  invitedBy: Types.ObjectId;
  email?: string;
  tokenHash: string;
  role: FamilyRole;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: Date;
  consumedAt?: Date;
  acceptedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const familySchema = new Schema<IFamily>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    description: { type: String, maxlength: 500 },
    timezone: { type: String, default: 'UTC' },
  },
  { timestamps: true },
);

const membershipSchema = new Schema<IFamilyMembership>(
  {
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['owner', 'admin', 'member'], required: true },
    nickname: { type: String, maxlength: 60 },
  },
  { timestamps: true },
);

membershipSchema.index({ familyId: 1, userId: 1 }, { unique: true });

const invitationSchema = new Schema<IFamilyInvitation>(
  {
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, lowercase: true, trim: true },
    // Only the SHA-256 hash of the raw token is stored; raw token is sent to the invitee.
    tokenHash: { type: String, required: true, unique: true },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'revoked', 'expired'],
      default: 'pending',
      index: true,
    },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const Family = model<IFamily>('Family', familySchema);
export const FamilyMembership = model<IFamilyMembership>('FamilyMembership', membershipSchema);
export const FamilyInvitation = model<IFamilyInvitation>('FamilyInvitation', invitationSchema);
