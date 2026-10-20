import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const createCallSchema = z.object({
  familyId: objectId,
  mode: z.enum(['audio', 'video']),
  conversationId: objectId.optional(),
  participantIds: z.array(objectId).min(1).max(20),
});

export const emergencyContactSchema = z.object({
  familyId: objectId,
  name: z.string().trim().min(1).max(120),
  relationship: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(5).max(30).regex(/^[+\-\s().0-9]+$/, 'Invalid phone number'),
  altPhone: z.string().trim().max(30).regex(/^[+\-\s().0-9]+$/).optional(),
  notes: z.string().trim().max(500).optional(),
  isPrimary: z.boolean().default(false),
});

export const createUpdateSchema = z.object({
  familyId: objectId,
  content: z.string().trim().min(1).max(2000),
  pinned: z.boolean().default(false),
});
