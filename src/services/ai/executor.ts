import { Types } from 'mongoose';
import { SessionUser } from '../../types/http';
import { Task } from '../../models/task';
import { CalendarEvent } from '../../models/calendarEvent';
import { Reminder } from '../../models/reminder';
import { FamilyMembership } from '../../models/family';
import { ChatConversation, ChatMessage } from '../../models/chat';
import { AIProposal } from '../../models/ai';
import { createNotification } from '../notification';
import { emitToUsers } from '../../lib/realtime';
import { HttpError, requireFamilyMembership } from '../../middleware/familyAccess';
import { logger } from '../../config/logger';
import {
  AnyProposalPayload,
  createTaskPayload,
  updateTaskPayload,
  proposeEventPayload,
  createReminderPayload,
  createChecklistPayload,
  draftMessagePayload,
  ProposalType,
} from './schemas';

/**
 * Executes a confirmed AI proposal through the same application services used
 * by manual actions. Every call re-asserts family membership (the proposal is
 * never trusted on its own) and re-validates the payload Zod-first.
 */
export async function executeConfirmedProposal(
  proposalId: string,
  userId: Types.ObjectId,
): Promise<{ type: ProposalType; result: Record<string, unknown> }> {
  const proposal = await AIProposal.findOne({ _id: proposalId, userId, status: 'pending' });
  if (!proposal) {
    throw new HttpError(404, 'Proposal not found, already handled, or not yours');
  }

  const { familyId } = await requireFamilyMembership(
    { user: { id: userId } as unknown as SessionUser },
    proposal.familyId.toString(),
  );

  try {
    let result: Record<string, unknown>;
    switch (proposal.type) {
      case 'create_task':
        result = await runCreateTask(
          createTaskPayload.parse(proposal.payload),
          familyId,
          userId,
        );
        break;
      case 'update_task':
        result = await runUpdateTask(updateTaskPayload.parse(proposal.payload), familyId, userId);
        break;
      case 'propose_event':
        result = await runProposeEvent(
          proposeEventPayload.parse(proposal.payload),
          familyId,
          userId,
        );
        break;
      case 'create_reminder':
        result = await runCreateReminder(
          createReminderPayload.parse(proposal.payload),
          familyId,
          userId,
        );
        break;
      case 'create_checklist':
        result = await runCreateChecklist(
          createChecklistPayload.parse(proposal.payload),
          familyId,
          userId,
        );
        break;
      case 'draft_message':
        result = await runDraftMessage(
          draftMessagePayload.parse(proposal.payload),
          familyId,
          userId,
        );
        break;
      default:
        throw new HttpError(400, 'Unsupported proposal type');
    }

    proposal.status = 'executed';
    proposal.result = result;
    await proposal.save();
    return { type: proposal.type as ProposalType, result };
  } catch (err) {
    proposal.status = 'failed';
    proposal.result = { error: (err as Error)?.message ?? 'Execution failed' };
    await proposal.save();
    throw err;
  }
}

async function resolveMemberByName(name: string | undefined, familyId: Types.ObjectId): Promise<Types.ObjectId | undefined> {
  if (!name) return undefined;
  const memberships = await FamilyMembership.find({ familyId }).populate('userId', 'name').lean();
  const target = memberships.find(
    (m) =>
      ((m.userId as unknown as { name: string }).name ?? '').toLowerCase() === name.toLowerCase(),
  );
  if (!target) {
    const names = memberships.map((m) => (m.userId as unknown as { name: string }).name).join(', ');
    throw new HttpError(400, `No family member named "${name}". Family members: ${names}`);
  }
  return target.userId as unknown as Types.ObjectId;
}

async function runCreateTask(
  payload: ReturnType<typeof createTaskPayload.parse>,
  familyId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<Record<string, unknown>> {
  const assigneeId =
    payload.assigneeName !== undefined
      ? await resolveMemberByName(payload.assigneeName, familyId)
      : undefined;

  if (assigneeId) {
    const membership = await FamilyMembership.findOne({ familyId, userId: assigneeId });
    if (!membership) throw new HttpError(400, 'Assignee is not a member of this family');
  }

  const task = await Task.create({
    familyId,
    title: payload.title,
    description: payload.description,
    priority: payload.priority,
    dueDate: payload.dueDate ? new Date(payload.dueDate) : undefined,
    assigneeId: assigneeId ?? userId, // AI-created unassigned tasks default to the requester
    createdById: userId,
    createdBy: 'ai',
  });

  if (assigneeId && !assigneeId.equals(userId)) {
    await createNotification({
      userId: assigneeId,
      familyId,
      type: 'task_assigned',
      title: `New task from family assistant: ${task.title}`,
      message: 'The AI assistant proposed this task and a family member confirmed it.',
      linkPath: '/tasks',
      refType: 'task',
      refId: task._id,
      dedupeKey: `ai-task-assign-${task._id}`,
    });
  }
  logger.info({ taskId: task._id, by: 'ai' }, 'Task created');
  return { taskId: task._id.toString(), title: task.title, assignedTo: payload.assigneeName ?? 'you' };
}

async function runUpdateTask(
  payload: ReturnType<typeof updateTaskPayload.parse>,
  familyId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<Record<string, unknown>> {
  const task = await Task.findOne({ _id: payload.taskId, familyId });
  if (!task) throw new HttpError(404, 'Task not found in this family');

  const statusChangedToCompleted = payload.status === 'completed' && task.status !== 'completed';
  if (payload.title) task.title = payload.title;
  if (payload.description !== undefined) task.description = payload.description;
  if (payload.status) task.status = payload.status;
  if (payload.priority) task.priority = payload.priority;
  if (payload.dueDate) task.dueDate = new Date(payload.dueDate);
  if (task.status === 'completed' && !task.completedAt) task.completedAt = new Date();
  await task.save();

  if (statusChangedToCompleted && task.assigneeId && !task.assigneeId.equals(task.createdById)) {
    await createNotification({
      userId: task.createdById,
      familyId,
      type: 'task_completed',
      title: `Task completed: ${task.title}`,
      linkPath: '/tasks',
      refType: 'task',
      refId: task._id,
      dedupeKey: `task-done-${task._id}-${Date.now()}`,
    });
  }
  return { taskId: task._id.toString(), title: task.title, status: task.status };
}

async function runProposeEvent(
  payload: ReturnType<typeof proposeEventPayload.parse>,
  familyId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<Record<string, unknown>> {
  const event = await CalendarEvent.create({
    familyId,
    title: payload.title,
    description: payload.description,
    location: payload.location,
    startAt: new Date(payload.startAt),
    endAt: new Date(payload.endAt),
    createdById: userId,
    participantIds: [userId],
    category: payload.category,
    createdBy: 'ai',
  });
  logger.info({ eventId: event._id, by: 'ai' }, 'Calendar event created');
  return { eventId: event._id.toString(), title: event.title };
}

async function runCreateReminder(
  payload: ReturnType<typeof createReminderPayload.parse>,
  familyId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<Record<string, unknown>> {
  const reminder = await Reminder.create({
    familyId,
    title: payload.title,
    notes: payload.notes,
    dueAt: new Date(payload.dueAt),
    remindFamily: payload.remindFamily,
    recipientIds: payload.remindFamily ? [] : [userId],
    recurrence: payload.recurrence,
    createdById: userId,
    createdBy: 'ai',
  });
  return {
    reminderId: reminder._id.toString(),
    title: reminder.title,
    dueAt: reminder.dueAt.toISOString(),
    recurrence: reminder.recurrence,
  };
}

async function runCreateChecklist(
  payload: ReturnType<typeof createChecklistPayload.parse>,
  familyId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<Record<string, unknown>> {
  const created: { id: string; title: string }[] = [];
  for (const item of payload.items) {
    const assigneeId = item.assigneeName
      ? await resolveMemberByName(item.assigneeName, familyId)
      : undefined;
    const task = await Task.create({
      familyId,
      title: item.title,
      priority: item.priority,
      dueDate: item.dueDate ? new Date(item.dueDate) : undefined,
      assigneeId: assigneeId ?? userId,
      createdById: userId,
      createdBy: 'ai',
    });
    created.push({ id: task._id.toString(), title: task.title });
    if (assigneeId && !assigneeId.equals(userId)) {
      await createNotification({
        userId: assigneeId,
        familyId,
        type: 'task_assigned',
        title: `New task from family assistant: ${task.title}`,
        linkPath: '/tasks',
        refType: 'task',
        refId: task._id,
        dedupeKey: `ai-task-assign-${task._id}`,
      } as never);
    }
  }
  return { createdCount: created.length, tasks: created };
}

/**
 * Sends the confirmed draft message through the real chat service. Sending is
 * gated behind the explicit "Confirm" click — this method is only reachable
 * after that confirmation.
 */
async function runDraftMessage(
  payload: ReturnType<typeof draftMessagePayload.parse>,
  familyId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<Record<string, unknown>> {
  let conversationId: Types.ObjectId | undefined;

  if (payload.toMemberName) {
    const memberships = await FamilyMembership.find({ familyId }).populate('userId', 'name').lean();
    const target = memberships.find(
      (m) =>
        ((m.userId as unknown as { _id: Types.ObjectId })._id.toString() !== userId.toString()) &&
        ((m.userId as unknown as { name: string }).name ?? '').toLowerCase() ===
          payload.toMemberName!.toLowerCase(),
    );
    if (!target) throw new HttpError(400, `No family member named "${payload.toMemberName}"`);
    const targetId = target.userId as unknown as Types.ObjectId;
    let conv = await ChatConversation.findOne({
      familyId,
      type: 'dm',
      participantIds: { $all: [userId, targetId], $size: 2 },
    });
    if (!conv) {
      conv = await ChatConversation.create({
        familyId,
        type: 'dm',
        participantIds: [userId, targetId],
        createdById: userId,
      });
    }
    conversationId = conv._id;
  } else {
    // No target named: deliver the draft to the family group (largest conversation) the user belongs to... 
    // Safer: ask the user to send manually. We do NOT auto-pick a conversation.
    throw new HttpError(
      400,
      'No recipient specified. Send this draft manually from Family Chat, or confirm again with a named recipient.',
    );
  }

  const conv = await ChatConversation.findOne({ _id: conversationId, participantIds: userId });
  if (!conv) throw new HttpError(403, 'You are not a participant of this conversation');

  const message = await ChatMessage.create({
    conversationId: conv._id,
    senderId: userId,
    content: payload.content,
    readBy: [{ userId, readAt: new Date() }],
  });

  conv.lastMessageAt = new Date();
  conv.lastMessagePreview = payload.content.slice(0, 140);
  await conv.save();

  const recipients = conv.participantIds.filter((p) => p.toString() !== userId.toString());
  emitToUsers(recipients, 'chat:new-message', {
    conversationId: conv._id.toString(),
    message: { _id: message._id, senderId: userId, content: payload.content, createdAt: message.createdAt },
  });
  for (const rid of recipients) {
    await createNotification({
      userId: rid as Types.ObjectId,
      familyId,
      type: 'chat_message',
      title: 'New family message',
      message: payload.content.slice(0, 120),
      linkPath: `/chats/${conv._id.toString()}`,
      refId: message._id,
      dedupeKey: `chat-${message._id}-${rid}`,
    });
  }
  return { messageId: message._id.toString(), conversationId: conv._id.toString() };
}
