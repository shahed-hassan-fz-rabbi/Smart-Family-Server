import { Request } from 'express';
import { Types } from 'mongoose';
import { FamilyMembership } from '../models/family';
import { SessionUser, FamilyRole } from '../types/http';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Loads the caller's membership for a family, or throws 403/404. */
export async function requireFamilyMembership(
  req: { user?: SessionUser } | Request,
  familyIdRaw: string,
  minRole: FamilyRole = 'member',
): Promise<{ familyId: Types.ObjectId; role: FamilyRole }> {
  const user = (req as { user?: SessionUser }).user;
  if (!user) {
    throw new HttpError(401, 'Authentication required');
  }
  if (!Types.ObjectId.isValid(familyIdRaw)) {
    throw new HttpError(404, 'Family not found');
  }
  const familyId = new Types.ObjectId(familyIdRaw);
  const membership = await FamilyMembership.findOne({ familyId, userId: user.id });
  if (!membership) {
    // Do not reveal whether the family exists.
    throw new HttpError(403, 'You are not a member of this family');
  }
  const rank: Record<FamilyRole, number> = { member: 1, admin: 2, owner: 3 };
  if (rank[membership.role as FamilyRole] < rank[minRole]) {
    throw new HttpError(403, 'You do not have permission for this action');
  }
  return { familyId, role: membership.role as FamilyRole };
}
