import { Router } from 'express';
import { Types } from 'mongoose';
import { Family, FamilyMembership, FamilyInvitation } from '../models/family';
import { User } from '../models/user';
import { requireAuth } from '../middleware/auth';
import { requireFamilyMembership, HttpError } from '../middleware/familyAccess';
import { validate } from '../middleware/validate';
import {
  createFamilySchema,
  updateFamilySchema,
  inviteSchema,
  acceptInvitationSchema,
  updateMemberSchema,
} from '../validators/family';
import { createNotification } from '../services/notification';

export const familiesRouter = Router();

familiesRouter.use(requireAuth);

// GET /api/families — families the caller belongs to
familiesRouter.get('/', async (req, res, next) => {
  try {
    const memberships = await FamilyMembership.find({ userId: req.user!.id }).lean();
    const familyIds = memberships.map((m) => m.familyId);
    const families = await Family.find({ _id: { $in: familyIds } }).lean();
    const roleByFamily = new Map(memberships.map((m) => [String(m.familyId), m.role]));
    res.json({
      families: families.map((f) => ({
        id: String(f._id),
        name: f.name,
        description: f.description,
        owner: String(f.ownerId) === String(req.user!.id),
        role: roleByFamily.get(String(f._id)) ?? 'member',
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/families — create a family (caller becomes owner)
familiesRouter.post('/', validate(createFamilySchema), async (req, res, next) => {
  try {
    const family = await Family.create({
      name: req.body.name,
      description: req.body.description,
      timezone: req.body.timezone ?? req.user!.timezone,
      ownerId: req.user!.id,
    });
    await FamilyMembership.create({
      familyId: family._id,
      userId: req.user!.id,
      role: 'owner',
    });
    res.status(201).json({ family: { id: String(family._id), name: family.name, role: 'owner' } });
  } catch (err) {
    next(err);
  }
});

// GET /api/families/:familyId — family detail with members (any member)
familiesRouter.get('/:familyId', async (req, res, next) => {
  try {
    await requireFamilyMembership(req, req.params.familyId);
    const family = await Family.findById(req.params.familyId).lean();
    if (!family) throw new HttpError(404, 'Family not found');
    const memberships = await FamilyMembership.find({ familyId: family._id })
      .populate('userId', 'name email avatarUrl preferredLanguage lastSeenAt privacy')
      .lean();
    res.json({
      family: {
        id: String(family._id),
        name: family.name,
        description: family.description,
        timezone: family.timezone,
        ownerId: String(family.ownerId),
      },
      members: memberships.map((m) => {
        const u = m.userId as unknown as {
          _id: Types.ObjectId;
          name: string;
          email: string;
          avatarUrl?: string;
          preferredLanguage: string;
          lastSeenAt?: Date;
          privacy?: { locationSharingOptIn?: boolean };
        };
        return {
          membershipId: String(m._id),
          userId: String(u._id),
          name: u.name,
          email: u.email,
          avatarUrl: u.avatarUrl,
          role: m.role,
          nickname: m.nickname,
          lastSeenAt: u.lastSeenAt,
          // Location is only surfaced when that member explicitly opted in.
          locationSharingOptIn: u.privacy?.locationSharingOptIn ?? false,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/families/:familyId — update family (owner/admin)
familiesRouter.patch('/:familyId', validate(updateFamilySchema), async (req, res, next) => {
  try {
    await requireFamilyMembership(req, req.params.familyId, 'admin');
    const family = await Family.findById(req.params.familyId);
    if (!family) throw new HttpError(404, 'Family not found');
    if (req.body.name) family.name = req.body.name;
    if (req.body.description !== undefined) family.description = req.body.description;
    if (req.body.timezone) family.timezone = req.body.timezone;
    await family.save();
    res.json({ family: { id: String(family._id), name: family.name } });
  } catch (err) {
    next(err);
  }
});

// POST /api/families/:familyId/invitations — create invite link/token (admin+)
familiesRouter.post('/:familyId/invitations', validate(inviteSchema), async (req, res, next) => {
  try {
    await requireFamilyMembership(req, req.params.familyId, 'admin');
    const { createHash, randomBytes } = await import('crypto');
    const raw = randomBytes(24).toString('hex');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const invitation = await FamilyInvitation.create({
      familyId: req.params.familyId,
      invitedBy: req.user!.id,
      email: req.body.email,
      tokenHash,
      role: req.body.role,
      status: 'pending',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    if (req.body.email) {
      const invitee = await User.findOne({ email: req.body.email.toLowerCase() });
      if (invitee) {
        await createNotification({
          userId: invitee._id as Types.ObjectId,
          familyId: new Types.ObjectId(req.params.familyId),
          type: 'family_invitation',
          title: `You've been invited to a family`,
          message: `${req.user!.name} invited you to join their family on Smart Family.`,
          linkPath: '/family/invitations',
          refType: 'invitation',
          refId: invitation._id as Types.ObjectId,
        });
      }
    }
    res.status(201).json({
      invitation: {
        id: String(invitation._id),
        token: raw,
        expiresAt: invitation.expiresAt,
        role: invitation.role,
        email: invitation.email ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/families/:familyId/invitations — list invitations (admin+)
familiesRouter.get('/:familyId/invitations', async (req, res, next) => {
  try {
    await requireFamilyMembership(req, req.params.familyId, 'admin');
    const invitations = await FamilyInvitation.find({ familyId: req.params.familyId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({
      invitations: invitations.map((i) => ({
        id: String(i._id),
        email: i.email,
        role: i.role,
        status: i.status,
        expiresAt: i.expiresAt,
        consumed: Boolean(i.consumedAt),
        createdAt: i.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/families/:familyId/invitations/:invitationId — revoke (admin+)
familiesRouter.delete('/:familyId/invitations/:invitationId', async (req, res, next) => {
  try {
    await requireFamilyMembership(req, req.params.familyId, 'admin');
    const invitation = await FamilyInvitation.findOne({
      _id: req.params.invitationId,
      familyId: req.params.familyId,
    });
    if (!invitation) throw new HttpError(404, 'Invitation not found');
    invitation.status = 'revoked';
    await invitation.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/families/invitations/accept — consume token (authed)
familiesRouter.post('/invitations/accept', validate(acceptInvitationSchema), async (req, res, next) => {
  try {
    const { createHash } = await import('crypto');
    const tokenHash = createHash('sha256').update(req.body.token).digest('hex');
    const invitation = await FamilyInvitation.findOne({ tokenHash });
    if (!invitation) throw new HttpError(400, 'This invitation is invalid');
    if (invitation.status !== 'pending' || invitation.consumedAt) {
      throw new HttpError(400, 'This invitation has already been used or was revoked');
    }
    if (invitation.expiresAt < new Date()) {
      invitation.status = 'expired';
      await invitation.save();
      throw new HttpError(400, 'This invitation has expired');
    }
    const already = await FamilyMembership.findOne({
      familyId: invitation.familyId,
      userId: req.user!.id,
    });
    if (already) throw new HttpError(409, 'You are already a member of this family');

    await FamilyMembership.create({
      familyId: invitation.familyId,
      userId: req.user!.id,
      role: invitation.role,
    });
    invitation.status = 'accepted';
    invitation.consumedAt = new Date();
    invitation.acceptedBy = req.user!.id;
    await invitation.save();
    res.json({ ok: true, familyId: String(invitation.familyId) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/families/:familyId/members/:membershipId — change role/nickname (owner only for roles)
familiesRouter.patch('/:familyId/members/:membershipId', validate(updateMemberSchema), async (req, res, next) => {
  try {
    await requireFamilyMembership(req, req.params.familyId, 'owner');
    const membership = await FamilyMembership.findOne({
      _id: req.params.membershipId,
      familyId: req.params.familyId,
    });
    if (!membership) throw new HttpError(404, 'Member not found');
    if (membership.role === 'owner') throw new HttpError(403, 'The family owner role cannot be changed');
    if (req.body.role) membership.role = req.body.role;
    if (req.body.nickname !== undefined) membership.nickname = req.body.nickname;
    await membership.save();
    res.json({ ok: true, role: membership.role });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/families/:familyId/members/me — leave family
// (registered before the :membershipId route so "me" is never treated as an id)
familiesRouter.delete('/:familyId/members/me', async (req, res, next) => {
  try {
    await requireFamilyMembership(req, req.params.familyId);
    const membership = await FamilyMembership.findOne({
      familyId: req.params.familyId,
      userId: req.user!.id,
    });
    if (!membership) throw new HttpError(404, 'Membership not found');
    if (membership.role === 'owner') {
      throw new HttpError(403, 'The family owner must transfer ownership or delete the family first');
    }
    await membership.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/families/:familyId/members/:membershipId — remove member (admin+, not owner)
familiesRouter.delete('/:familyId/members/:membershipId', async (req, res, next) => {
  try {
    await requireFamilyMembership(req, req.params.familyId, 'admin');
    const membership = await FamilyMembership.findOne({
      _id: req.params.membershipId,
      familyId: req.params.familyId,
    });
    if (!membership) throw new HttpError(404, 'Member not found');
    if (membership.role === 'owner') throw new HttpError(403, 'The family owner cannot be removed here');
    await membership.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/families/invitations/mine — invitations received via email notifications list
familiesRouter.get('/invitations/mine', async (req, res, next) => {
  try {
    const user = await User.findById(req.user!.id).select('email');
    if (!user) throw new HttpError(404, 'Account not found');
    const invitations = await FamilyInvitation.find({
      email: user.email,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    })
      .populate('familyId', 'name')
      .lean();
    res.json({
      invitations: invitations.map((i) => ({
        id: String(i._id),
        familyName: (i.familyId as unknown as { name: string }).name,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        // The token hash cannot be reversed — invitee must use the emailed link.
      })),
    });
  } catch (err) {
    next(err);
  }
});
