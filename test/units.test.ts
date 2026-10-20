import { describe, expect, it } from 'vitest';
import { nextOccurrence, processDueReminders } from '../src/services/reminderScheduler';
import { createTaskSchema, createEventSchema, listTasksQuery } from '../src/validators/content';
import { registerSchema, loginSchema } from '../src/validators/auth';
import { emergencyContactSchema } from '../src/validators/safety';
import { aiReplySchema } from '../src/services/ai/schemas';
import { roleAtLeast } from '../src/middleware/auth';

describe('validators — content', () => {
  it('accepts a valid task', () => {
    const ok = createTaskSchema.safeParse({
      familyId: 'a'.repeat(24),
      title: 'Buy medicine',
      priority: 'high',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a task without title', () => {
    const bad = createTaskSchema.safeParse({ familyId: 'a'.repeat(24), title: '' });
    expect(bad.success).toBe(false);
  });

  it('rejects an event ending before it starts', () => {
    const bad = createEventSchema.safeParse({
      familyId: 'a'.repeat(24),
      title: 'Party',
      startAt: '2026-11-05T18:00:00.000Z',
      endAt: '2026-11-05T17:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects an event with invalid dates', () => {
    const bad = createEventSchema.safeParse({
      familyId: 'a'.repeat(24),
      title: 'Party',
      startAt: 'not-a-date',
      endAt: 'also-not-a-date',
    });
    expect(bad.success).toBe(false);
  });

  it('applies default pagination', () => {
    const q = listTasksQuery.parse({ familyId: 'a'.repeat(24) });
    expect(q.limit).toBe(50);
    expect(q.skip).toBe(0);
  });
});

describe('validators — auth', () => {
  it('accepts a valid registration', () => {
    const ok = registerSchema.safeParse({
      name: 'Rafi Hassan',
      email: 'rafi@example.com',
      password: 'LongEnough123',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects short passwords', () => {
    const bad = registerSchema.safeParse({ name: 'Rafi', email: 'r@example.com', password: 'short' });
    expect(bad.success).toBe(false);
  });

  it('rejects invalid emails at login', () => {
    const bad = loginSchema.safeParse({ email: 'not-an-email', password: 'whatever' });
    expect(bad.success).toBe(false);
  });
});

describe('validators — safety', () => {
  it('rejects a malformed phone number', () => {
    const bad = emergencyContactSchema.safeParse({
      familyId: 'a'.repeat(24),
      name: 'Uncle Karim',
      relationship: 'Neighbour',
      phone: 'call me maybe',
    });
    expect(bad.success).toBe(false);
  });

  it('accepts an international phone number', () => {
    const ok = emergencyContactSchema.safeParse({
      familyId: 'a'.repeat(24),
      name: 'Uncle Karim',
      relationship: 'Neighbour',
      phone: '+880 1712-345678',
    });
    expect(ok.success).toBe(true);
  });
});

describe('AI reply schema', () => {
  it('accepts a plain reply', () => {
    const ok = aiReplySchema.safeParse({ reply: 'How can I help your family today?' });
    expect(ok.success).toBe(true);
  });

  it('accepts a structured proposal with a typed payload', () => {
    const ok = aiReplySchema.safeParse({
      reply: 'I suggest creating this task now.',
      proposal: {
        type: 'create_task',
        payload: { title: 'Pack medicine bag', priority: 'high' },
      },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects malformed proposals (e.g. bad enums)', () => {
    const bad = aiReplySchema.safeParse({
      reply: 'ok',
      proposal: { type: 'create_task', payload: { title: 'x', priority: 'urgent' } },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects an unknown proposal type', () => {
    const bad = aiReplySchema.safeParse({ reply: 'ok', proposal: { type: 'delete_everything', payload: {} } });
    expect(bad.success).toBe(false);
  });
});

describe('backend checks before execution — Banglish conversation sample', () => {
  it('parses a realistic Banglish assistant turn with a proposal', () => {
    const sample = {
      reply: 'মা এর ডাক্তার শুরু করার আগে ওষুধ ব্যাগ প্রস্তুত করা দরকার I created a proposal for the checklist.',
      proposal: {
        type: 'create_checklist',
        payload: {
          description: 'Doctor appointment preparation',
          items: [
            { title: 'Pack medicine bag', priority: 'high' },
            { title: 'Book the car', priority: 'medium' },
          ],
        },
      },
    };
    expect(aiReplySchema.safeParse(sample).success).toBe(true);
  });
});

describe('role ranks', () => {
  it('lets admins but not members remove members', () => {
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('member', 'admin')).toBe(false);
  });
});

describe('reminder scheduling', () => {
  it('advances weekly reminders exactly 7 days', () => {
    const from = new Date('2026-11-01T09:00:00.000Z');
    const next = nextOccurrence(from, 'weekly');
    expect(next.toISOString()).toBe('2026-11-08T09:00:00.000Z');
  });

  it('advances monthly reminders by one month without overflow (Jan 31 → Feb 28)', () => {
    const next = nextOccurrence(new Date('2026-01-31T09:00:00.000Z'), 'monthly');
    expect(next.toISOString()).toBe('2026-02-28T09:00:00.000Z');
  });

  it('exposes processDueReminders as callable (no DB in unit mode)', async () => {
    // Prove the import survives without a live Mongo connection.
    expect(typeof processDueReminders).toBe('function');
  });
});
