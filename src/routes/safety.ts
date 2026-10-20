import { Router } from 'express';
import { Types } from 'mongoose';
import { EmergencyContact, FamilyUpdate } from '../models/safety';
import { requireAuth, roleAtLeast } from '../middleware/auth';
import { requireFamilyMembership, HttpError } from '../middleware/familyAccess';
import { validate } from '../middleware/validate';
import { emergencyContactSchema, createUpdateSchema } from '../validators/safety';
import { User } from '../models/user';
import { emitToUsers } from '../lib/realtime';

export const safetyRouter = Router();

safetyRouter.use(requireAuth);

// ---- Emergency contacts (family-level, member-visible, admin-managed) ----

safetyRouter.get('/:familyId/emergency-contacts', async (req, res, next) => {
  try {
    await requireFamilyMembership(req, req.params.familyId);
    const contacts = await EmergencyContact.find({ familyId: req.params.familyId })
      .sort({ isPrimary: -1, name: 1 })
      .lean();
    res.json({
      contacts: contacts.map((c) => ({
        id: String(c._id),
        name: c.name,
        relationship: c.relationship,
        phone: c.phone,
        altPhone: c.altPhone,
        notes: c.notes,
        isPrimary: c.isPrimary,
      })),
    });
  } catch (err) {
    next(err);
  }
});

safetyRouter.post('/:familyId/emergency-contacts', validate(emergencyContactSchema), async (req, res, next) => {
  try {
    const { familyId, role } = await requireFamilyMembership(req, req.params.familyId, 'admin');
    if (req.body.isPrimary) {
      await EmergencyContact.updateMany({ familyId }, { $set: { isPrimary: false } });
    }
    const contact = await EmergencyContact.create({
      familyId,
      createdById: req.user!.id,
      ...req.body,
    });
    res.status(201).json({ contact: { id: String(contact._id), name: contact.name } });
  } catch (err) {
    next(err);
  }
});

safetyRouter.delete('/:familyId/emergency-contacts/:contactId', async (req, res, next) => {
  try {
    const { familyId, role } = await requireFamilyMembership(req, req.params.familyId, 'admin');
    void roleAtLeast(role, 'admin');
    const result = await EmergencyContact.deleteOne({
      _id: req.params.contactId,
      familyId,
    });
    if (result.deletedCount === 0) throw new HttpError(404, 'Contact not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Explicit, user-initiated SOS handoff.
 *
 * What this does: records that the user tapped SOS, compiles their chosen
 * emergency contacts and opt-in shared location status into an alert payload,
 * and delivers it to the other family members in-app.
 *
 * What this does NOT do: contact emergency services or dispatch anyone.
 */
safetyRouter.post('/:familyId/sos', async (req, res, next) => {
  try {
    const { familyId } = await requireFamilyMembership(req, req.params.familyId);
    const me = await User.findById(req.user!.id);
    if (!me) throw new HttpError(404, 'Account not found');

    const contacts = await EmergencyContact.find({ familyId }).sort({ isPrimary: -1 }).lean();
    const contactList = contacts
      .slice(0, 5)
      .map((c) => `${c.name} (${c.relationship}): ${c.phone}`)
      .join('\n');

    const locationNote = me.privacy.locationSharingOptIn
      ? 'This member has opted in to location sharing in their privacy settings. Use the contact info above and your own communication to reach them.'
      : 'This member has NOT opted in to location sharing. No location data exists.';

    const members = await (await import('../models/family')).FamilyMembership.find({ familyId }).lean();
    const others = members.map((m) => m.userId).filter((id) => id.toString() !== String(req.user!.id));

    await emitToUsers(others, 'safety:sos', {
      from: me.name,
      message: `${me.name} has raised an SOS alert in the family app`,
      contacts: contactList,
      locationNote,
    });

    res.json({
      ok: true,
      message:
        'SOS alert sent to your family members in the app. Smart Family does not contact emergency services automatically — please call your local emergency number directly if you need immediate help.',
      contactsProvided: contacts.length,
      locationShared: me.privacy.locationSharingOptIn,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Family updates ----

safetyRouter.get('/:familyId/updates', async (req, res, next) => {
  try {
    await requireFamilyMembership(req, req.params.familyId);
    const updates = await FamilyUpdate.find({ familyId: req.params.familyId })
      .sort({ pinned: -1, createdAt: -1 })
      .limit(50)
      .populate('authorId', 'name')
      .lean();
    res.json({
      updates: updates.map((u) => ({
        id: String(u._id),
        content: u.content,
        author: (u.authorId as unknown as { name: string }).name,
        isMine: String((u.authorId as unknown as { _id: Types.ObjectId })._id) === String(req.user!.id),
        pinned: u.pinned,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

safetyRouter.post('/:familyId/updates', validate(createUpdateSchema), async (req, res, next) => {
  try {
    const { familyId } = await requireFamilyMembership(req, req.params.familyId);
    const me = await User.findById(req.user!.id);
    if (me && !me.privacy.shareUpdatesWithFamily) {
      throw new HttpError(403, 'You have disabled sharing updates with family in your privacy settings');
    }
    const update = await FamilyUpdate.create({
      familyId,
      authorId: req.user!.id,
      content: req.body.content,
      pinned: req.body.pinned ?? false,
    });
    res.status(201).json({ update: { id: String(update._id) } });
  } catch (err) {
    next(err);
  }
});

safetyRouter.delete('/:familyId/updates/:updateId', async (req, res, next) => {
  try {
    const { familyId } = await requireFamilyMembership(req, req.params.familyId);
    const update = await FamilyUpdate.findOne({ _id: req.params.updateId, familyId });
    if (!update) throw new HttpError(404, 'Update not found');
    if (String(update.authorId) !== String(req.user!.id)) {
      throw new HttpError(403, 'Only the author can delete this update');
    }
    await update.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
