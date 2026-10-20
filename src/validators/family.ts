import { z } from 'zod';

export const createFamilySchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  timezone: z.string().max(60).optional(),
});

export const updateFamilySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  timezone: z.string().max(60).optional(),
});

export const inviteSchema = z.object({
  email: z.string().trim().email().max(200).optional(),
  role: z.enum(['admin', 'member']).default('member'),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(16).max(256),
});

export const updateMemberSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  nickname: z.string().trim().max(60).optional(),
});
