import { z } from 'zod';

/**
 * Typed schemas for every action the AI may propose. The backend validates a
 * proposal again (against the same schemas) before executing it — the AI never
 * executes anything directly and never writes to the database itself.
 */

const isoDate = z.string().datetime({ offset: true });
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const createTaskPayload = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  dueDate: isoDate.optional(),
  assigneeName: z.string().trim().max(80).optional(),
});

export const updateTaskPayload = z.object({
  taskId: objectId,
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(['pending', 'in_progress', 'completed']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  dueDate: isoDate.optional(),
});

export const proposeEventPayload = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  location: z.string().trim().max(240).optional(),
  startAt: isoDate,
  endAt: isoDate,
  category: z.enum(['appointment', 'family_event', 'personal', 'other']).default('other'),
});

export const createReminderPayload = z.object({
  title: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(1000).optional(),
  dueAt: isoDate,
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'),
  remindFamily: z.boolean().default(false),
});

export const createChecklistPayload = z.object({
  description: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        dueDate: isoDate.optional(),
        priority: z.enum(['low', 'medium', 'high']).default('medium'),
        assigneeName: z.string().trim().max(80).optional(),
      }),
    )
    .min(1)
    .max(15),
});

export const draftMessagePayload = z.object({
  content: z.string().trim().min(1).max(4000),
  toMemberName: z.string().trim().max(80).optional(),
});

export const proposalPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_task'), payload: createTaskPayload }),
  z.object({ type: z.literal('update_task'), payload: updateTaskPayload }),
  z.object({ type: z.literal('propose_event'), payload: proposeEventPayload }),
  z.object({ type: z.literal('create_reminder'), payload: createReminderPayload }),
  z.object({ type: z.literal('create_checklist'), payload: createChecklistPayload }),
  z.object({ type: z.literal('draft_message'), payload: draftMessagePayload }),
]);

export type ProposalType =
  | 'create_task'
  | 'update_task'
  | 'propose_event'
  | 'create_reminder'
  | 'create_checklist'
  | 'draft_message';

export type AnyProposalPayload =
  | z.infer<typeof createTaskPayload>
  | z.infer<typeof updateTaskPayload>
  | z.infer<typeof proposeEventPayload>
  | z.infer<typeof createReminderPayload>
  | z.infer<typeof createChecklistPayload>
  | z.infer<typeof draftMessagePayload>;

/** The strict JSON envelope the AI must return for every turn. */
export const aiReplySchema = z.object({
  reply: z.string().min(1).max(6000),
  needsClarification: z.string().max(1000).optional(),
  proposal: proposalPayloadSchema.optional(),
});

export type AiReply = z.infer<typeof aiReplySchema>;
