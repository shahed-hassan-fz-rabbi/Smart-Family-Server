import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const createTaskSchema = z.object({
  familyId: objectId,
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  dueDate: z.string().datetime({ offset: true }).optional(),
  assigneeId: objectId.optional(),
});

export const updateTaskSchema = createTaskSchema.partial().extend({
  status: z.enum(['pending', 'in_progress', 'completed']).optional(),
});

export const listTasksQuery = z.object({
  familyId: objectId,
  status: z.enum(['pending', 'in_progress', 'completed']).optional(),
  assigneeId: objectId.optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const createEventSchema = z
  .object({
    familyId: objectId,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).optional(),
    location: z.string().trim().max(240).optional(),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
    category: z.enum(['appointment', 'family_event', 'personal', 'other']).default('other'),
    participantIds: z.array(objectId).max(50).optional(),
  })
  .refine((v) => new Date(v.startAt) < new Date(v.endAt), {
    message: 'startAt must be before endAt',
    path: ['endAt'],
  });

export const updateEventSchema = createEventSchema.innerType().partial().refine(
  (v) => !v.startAt || !v.endAt || new Date(v.startAt) < new Date(v.endAt),
  { message: 'startAt must be before endAt', path: ['endAt'] },
);

export const listEventsQuery = z.object({
  familyId: objectId,
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
