/**
 * Reproducible demo seed.
 *
 * Creates one demo family with two members and realistic sample data.
 * This is DEVELOPMENT-ONLY data — never run against production.
 *
 * Usage: npm run seed
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User } from '../models/user';
import { Family, FamilyMembership } from '../models/family';
import { Task } from '../models/task';
import { CalendarEvent } from '../models/calendarEvent';
import { Reminder } from '../models/reminder';
import { EmergencyContact } from '../models/safety';
import { ChatConversation, ChatMessage } from '../models/chat';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI is missing. Copy .env.example to .env and configure it first.');
  process.exit(1);
}

const DEMO_PREFIX = '[demo] ';

async function main() {
  await mongoose.connect(MONGODB_URI!);
  console.log('Connected. Seeding demo data (development only)...');

  // Idempotent: remove previously seeded demo users first.
  const existingDemoUsers = await User.find({ name: { $regex: /^\[demo\] / } });
  for (const u of existingDemoUsers) {
    await FamilyMembership.deleteMany({ userId: u._id });
    await Task.deleteMany({ createdById: u._id });
    await CalendarEvent.deleteMany({ createdById: u._id });
    await Reminder.deleteMany({ createdById: u._id });
    await EmergencyContact.deleteMany({ createdById: u._id });
    await ChatMessage.deleteMany({ senderId: u._id });
    await ChatConversation.deleteMany({ createdById: u._id });
    await User.deleteOne({ _id: u._id });
  }
  await Family.deleteMany({ name: { $regex: /^\[demo\] / } });

  const passwordHash = await bcrypt.hash('DemoFamily2026!', 12);
  const mother = await User.create({
    name: `${DEMO_PREFIX}Nusrat (Mom)`,
    email: 'nusrat.demo@smartfamily.test',
    passwordHash,
  });
  const son = await User.create({
    name: `${DEMO_PREFIX}Rafi (Son)`,
    email: 'rafi.demo@smartfamily.test',
    passwordHash,
  });

  const family = await Family.create({
    name: `${DEMO_PREFIX}The Hassan Family`,
    ownerId: mother._id,
    description: 'Demo family — safe to delete.',
  });
  await FamilyMembership.create({ familyId: family._id, userId: mother._id, role: 'owner' });
  await FamilyMembership.create({ familyId: family._id, userId: son._id, role: 'member' });

  const now = new Date();
  const day = (offset: number) => new Date(now.getTime() + offset * 86400000);

  await Task.create([
    {
      familyId: family._id,
      title: 'Prepare medication bag for doctor appointment',
      status: 'pending',
      priority: 'high',
      dueDate: day(1),
      assigneeId: mother._id,
      createdById: son._id,
    },
    {
      familyId: family._id,
      title: 'Buy groceries for the week',
      status: 'in_progress',
      priority: 'medium',
      dueDate: day(2),
      assigneeId: son._id,
      createdById: son._id,
    },
    {
      familyId: family._id,
      title: 'Schedule plumber visit for kitchen',
      status: 'pending',
      priority: 'low',
      assigneeId: mother._id,
      createdById: mother._id,
    },
  ]);

  await CalendarEvent.create([
    {
      familyId: family._id,
      title: `${DEMO_PREFIX}Doctor appointment (Mom's mother)`,
      startAt: day(1),
      endAt: new Date(day(1).getTime() + 3600000),
      location: 'Green Hospital, Room 4B',
      category: 'appointment',
      createdById: son._id,
      participantIds: [mother._id],
    },
    {
      familyId: family._id,
      title: `${DEMO_PREFIX}Friday family dinner call`,
      startAt: day(3),
      endAt: new Date(day(3).getTime() + 2 * 3600000),
      category: 'family_event',
      createdById: mother._id,
      participantIds: [mother._id, son._id],
    },
  ]);

  await Reminder.create([
    {
      familyId: family._id,
      title: `${DEMO_PREFIX}Review next week's schedule`,
      dueAt: day(2),
      remindFamily: true,
      recurrence: 'weekly',
      createdById: mother._id,
    },
    {
      familyId: family._id,
      title: `${DEMO_PREFIX}Confirm prescription refill`,
      dueAt: day(1),
      recipientIds: [mother._id],
      createdById: son._id,
    },
  ]);

  await EmergencyContact.create({
    familyId: family._id,
    createdById: mother._id,
    name: 'Dr. Karim — GP',
    relationship: 'Family physician office',
    phone: '+880-1700-000000',
    notes: 'Replace with a real contact.',
    isPrimary: true,
  });

  const dm = await ChatConversation.create({
    familyId: family._id,
    type: 'dm',
    participantIds: [mother._id, son._id],
    createdById: son._id,
  });
  await ChatMessage.create({
    conversationId: dm._id,
    senderId: son._id,
    content: `${DEMO_PREFIX}Reminder set for the doctor appointment tomorrow, Ma.`,
    readBy: [{ userId: son._id, readAt: new Date() }],
  });

  console.log('Seed complete.');
  console.log('Demo accounts (development only):');
  console.log('  nusrat.demo@smartfamily.test / DemoFamily2026!');
  console.log('  rafi.demo@smartfamily.test   / DemoFamily2026!');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
