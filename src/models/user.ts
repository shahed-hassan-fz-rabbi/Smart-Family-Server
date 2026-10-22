import { Schema, model, Document, Types } from 'mongoose';

export type FamilyRole = 'owner' | 'admin' | 'member';
/** Platform-level role, fully independent of family roles. */
export type PlatformRole = 'user' | 'super_admin';

export interface IUser extends Document<Types.ObjectId> {
  name: string;
  email: string;
  passwordHash: string;
  avatarUrl?: string;
  /** Platform privilege. Only the secure bootstrap script may ever set 'super_admin'. */
  role: PlatformRole;
  /** Suspension (account-level, reversible). Suspended users fail requireAuth. */
  suspendedAt?: Date | null;
  suspendReason?: string;
  suspendedBy?: Types.ObjectId;
  preferredLanguage: 'en' | 'bn' | 'banglish';
  timezone: string;
  privacy: {
    shareUpdatesWithFamily: boolean;
    shareCalendarWithFamily: boolean;
    locationSharingOptIn: boolean;
    aiFamilyContextAllowed: boolean;
  };
  notificationPrefs: {
    inApp: boolean;
    emailEnabled: boolean;
  };
  lastSeenAt?: Date;
  deletedAt?: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true },
    avatarUrl: { type: String },
    role: { type: String, enum: ['user', 'super_admin'], default: 'user', index: true },
    suspendedAt: { type: Date, default: null },
    suspendReason: { type: String, maxlength: 300 },
    suspendedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    preferredLanguage: { type: String, enum: ['en', 'bn', 'banglish'], default: 'en' },
    timezone: { type: String, default: 'UTC' },
    privacy: {
      shareUpdatesWithFamily: { type: Boolean, default: true },
      shareCalendarWithFamily: { type: Boolean, default: true },
      locationSharingOptIn: { type: Boolean, default: false },
      aiFamilyContextAllowed: { type: Boolean, default: true },
    },
    notificationPrefs: {
      inApp: { type: Boolean, default: true },
      emailEnabled: { type: Boolean, default: false },
    },
    lastSeenAt: { type: Date },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const User = model<IUser>('User', userSchema);
