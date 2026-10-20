import { z } from 'zod';

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    preferredLanguage: z.enum(['en', 'bn', 'banglish']).optional(),
    timezone: z.string().max(60).optional(),
    privacy: z
      .object({
        shareUpdatesWithFamily: z.boolean().optional(),
        shareCalendarWithFamily: z.boolean().optional(),
        locationSharingOptIn: z.boolean().optional(),
        aiFamilyContextAllowed: z.boolean().optional(),
      })
      .optional(),
    notificationPrefs: z
      .object({
        inApp: z.boolean().optional(),
        emailEnabled: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const reminderSchema = z.object({
  familyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id'),
  title: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(1000).optional(),
  dueAt: z.string().datetime({ offset: true }),
  remindFamily: z.boolean().default(false),
  recipientIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).max(50).default([]),
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'),
  taskId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  eventId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

export const updateReminderSchema = reminderSchema.partial().extend({
  status: z.enum(['pending', 'completed', 'dismissed']).optional(),
});
