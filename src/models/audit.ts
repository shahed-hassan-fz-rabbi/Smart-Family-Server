import { Schema, model, Document, Types } from 'mongoose';

export interface IAuditLog extends Document<Types.ObjectId> {
  /** Who performed the action (null for the very first bootstrap promotion). */
  actorId?: Types.ObjectId | null;
  actorEmail?: string;
  /** Machine-readable action, e.g. 'platform.user.suspended'. */
  action: string;
  targetType?: 'user' | 'family' | 'platform';
  targetId?: Types.ObjectId | null;
  /** Small, non-secret details (emails, reasons, counts). Never passwords/tokens. */
  meta?: Record<string, unknown>;
  ip?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorEmail: { type: String, lowercase: true },
    action: { type: String, required: true, index: true, maxlength: 80 },
    targetType: { type: String, enum: ['user', 'family', 'platform'], default: 'platform' },
    targetId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    meta: { type: Object, default: undefined },
    ip: { type: String },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    // Audit entries are immutable — never returned by save/patch updates.
    versionKey: false,
  },
);

auditLogSchema.post('save', () => {
  /* Intentionally non-deleting; entries are append-only by convention. */
});
void auditLogSchema;

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema);

/**
 * Appends an immutable audit trail entry. Failures are logged but never thrown
 * so that auditing cannot break the primary action for a family member flow.
 */
export async function logAudit(entry: {
  actorId?: Types.ObjectId | null;
  actorEmail?: string;
  action: string;
  targetType?: 'user' | 'family' | 'platform';
  targetId?: Types.ObjectId | null;
  meta?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  try {
    await AuditLog.create({
      actorId: entry.actorId ?? null,
      actorEmail: entry.actorEmail,
      action: entry.action,
      targetType: entry.targetType ?? 'platform',
      targetId: entry.targetId ?? null,
      meta: entry.meta,
      ip: entry.ip,
    });
  } catch (err) {
    // Never let audit-write failures break user-facing flows.
    console.error('audit log write failed', err);
  }
}
