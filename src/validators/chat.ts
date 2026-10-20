import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const createConversationSchema = z.object({
  familyId: objectId,
  type: z.enum(['dm', 'group']),
  participantIds: z.array(objectId).min(2).max(100),
  name: z.string().trim().max(120).optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1, 'Message cannot be empty').max(4000),
  clientId: z.string().max(64).optional(), // client dedupe id
});

export const listMessagesQuery = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
