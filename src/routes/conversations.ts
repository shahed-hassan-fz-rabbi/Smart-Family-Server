import { Router } from 'express';
import { Types } from 'mongoose';
import { ChatConversation, ChatMessage } from '../models/chat';
import { requireAuth } from '../middleware/auth';
import { requireFamilyMembership, HttpError } from '../middleware/familyAccess';
import { validate } from '../middleware/validate';
import { createConversationSchema, sendMessageSchema, listMessagesQuery } from '../validators/chat';
import { createNotification } from '../services/notification';
import { emitToUsers } from '../lib/realtime';

export const conversationsRouter = Router();

conversationsRouter.use(requireAuth);

conversationsRouter.get('/', async (req, res, next) => {
  try {
    const familyId = req.query.familyId as string | undefined;
    if (!familyId) throw new HttpError(400, 'familyId query parameter is required');
    await requireFamilyMembership(req, familyId);

    // Membership filter in the query itself — clients can never list another family's chats.
    const conversations = await ChatConversation.find({
      familyId: new Types.ObjectId(familyId),
      participantIds: req.user!.id,
      archivedBy: { $ne: req.user!.id },
    })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(100)
      .populate('participantIds', 'name avatar')
      .lean();

    // Unread counts per conversation (messages not read by me, sent by others).
    const unreadMap = new Map<string, number>();
    await Promise.all(
      conversations.map(async (c) => {
        const count = await ChatMessage.countDocuments({
          conversationId: c._id,
          readBy: { $not: { $elemMatch: { userId: req.user!.id } } },
          senderId: { $ne: req.user!.id },
        });
        unreadMap.set(String(c._id), count);
      }),
    );

    res.json({
      conversations: conversations.map((c) => ({
        id: String(c._id),
        type: c.type,
        name: c.type === 'group' ? c.name : null,
        participants: (c.participantIds as unknown as { _id: Types.ObjectId; name: string }[]).map((p) => ({
          id: String(p._id),
          name: p.name,
          isMe: String(p._id) === String(req.user!.id),
        })),
        lastMessageAt: c.lastMessageAt,
        preview: c.lastMessagePreview,
        unreadCount: unreadMap.get(String(c._id)) ?? 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

conversationsRouter.post('/', validate(createConversationSchema), async (req, res, next) => {
  try {
    const { familyId } = await requireFamilyMembership(req, req.body.familyId);
    const participantIds: string[] = Array.from(new Set<string>(req.body.participantIds.map(String)));
    if (!participantIds.includes(String(req.user!.id))) participantIds.push(String(req.user!.id));

    // Every participant must be a member of this family.
    for (const p of participantIds) {
      await assertFamilyMember(familyId, p);
    }

    if (req.body.type === 'dm') {
      if (participantIds.length !== 2) throw new HttpError(400, 'A direct conversation needs exactly 2 participants');
      const existing = await ChatConversation.findOne({
        familyId,
        type: 'dm',
        participantIds: { $all: participantIds, $size: 2 },
      }).lean();
      if (existing) {
        res.json({ conversation: { id: String(existing._id) }, existed: true });
        return;
      }
    }

    const conversation = await ChatConversation.create({
      familyId,
      type: req.body.type,
      name: req.body.type === 'group' ? req.body.name : undefined,
      participantIds: participantIds.map((p) => new Types.ObjectId(p)),
      createdById: req.user!.id,
    });
    res.status(201).json({ conversation: { id: String(conversation._id) } });
  } catch (err) {
    next(err);
  }
});

conversationsRouter.get('/:conversationId', async (req, res, next) => {
  try {
    const conv = await assertParticipant(req, req.params.conversationId);
    const populated = await ChatConversation.findById(conv._id).populate('participantIds', 'name').lean();
    res.json({
      conversation: {
        id: String(conv._id),
        type: conv.type,
        name: conv.name,
        participants: (populated!.participantIds as unknown as { _id: Types.ObjectId; name: string }[]).map((p) => ({
          id: String(p._id),
          name: p.name,
          isMe: String(p._id) === String(req.user!.id),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

conversationsRouter.get('/:conversationId/messages', validate(listMessagesQuery, 'query'), async (req, res, next) => {
  try {
    const conv = await assertParticipant(req, req.params.conversationId);
    const limit = (req as unknown as { query: { limit: number } }).query.limit;
    const filter: Record<string, unknown> = { conversationId: conv._id };
    if (req.query.before) filter.createdAt = { $lt: new Date(req.query.before as string) };

    const messages = await ChatMessage.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('senderId', 'name')
      .lean();

    res.json({
      messages: messages.reverse().map((m) => ({
        id: String(m._id),
        senderId: String(m.senderId),
        senderName: (m.senderId as unknown as { name: string }).name,
        content: m.content,
        createdAt: m.createdAt,
        readByMe: (m.readBy ?? []).some((r) => r.userId?.toString() === String(req.user!.id)),
      })),
      hasMore: messages.length === limit,
    });
  } catch (err) {
    next(err);
  }
});

conversationsRouter.post('/:conversationId/messages', validate(sendMessageSchema), async (req, res, next) => {
  try {
    const conv = await assertParticipant(req, req.params.conversationId);
    if (req.body.clientId) {
      // Idempotency guard for client retries/reconnects.
      const dupe = await ChatMessage.findOne({
        conversationId: conv._id,
        senderId: req.user!.id,
        content: req.body.content,
        createdAt: { $gte: new Date(Date.now() - 10_000) },
      });
      if (dupe) {
        res.json({ message: { id: String(dupe._id) }, duplicate: true });
        return;
      }
    }
    const message = await ChatMessage.create({
      conversationId: conv._id,
      senderId: req.user!.id,
      content: req.body.content,
      readBy: [{ userId: req.user!.id, readAt: new Date() }],
    });
    conv.lastMessageAt = message.createdAt as Date;
    conv.lastMessagePreview = req.body.content.slice(0, 140);
    await conv.save();

    const others = conv.participantIds.filter((p) => p.toString() !== String(req.user!.id));
    const payload = {
      conversationId: String(conv._id),
      message: {
        _id: String(message._id),
        senderId: String(req.user!.id),
        senderName: req.user!.name,
        content: req.body.content,
        createdAt: message.createdAt,
      },
    };
    emitToUsers(others, 'chat:new-message', payload);
    for (const o of others) {
      await createNotification({
        userId: o as Types.ObjectId,
        familyId: conv.familyId,
        type: 'chat_message',
        title: `${req.user!.name} sent a message`,
        message: req.body.content.slice(0, 120),
        linkPath: `/chats/${conv._id.toString()}`,
        refId: message._id as Types.ObjectId,
        dedupeKey: `chat-${message._id}-${o}`,
      });
    }
    res.status(201).json({ message: { id: String(message._id), createdAt: message.createdAt } });
  } catch (err) {
    next(err);
  }
});

conversationsRouter.post('/:conversationId/read', async (req, res, next) => {
  try {
    const conv = await assertParticipant(req, req.params.conversationId);
    await ChatMessage.updateMany(
      {
        conversationId: conv._id,
        senderId: { $ne: req.user!.id },
        readBy: { $not: { $elemMatch: { userId: req.user!.id } } },
      },
      { $push: { readBy: { userId: req.user!.id, readAt: new Date() } } },
    );
    emitToUsers(
      conv.participantIds.filter((p) => p.toString() !== String(req.user!.id)),
      'chat:read',
      { conversationId: String(conv._id), userId: String(req.user!.id) },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

conversationsRouter.post('/:conversationId/typing', async (req, res, next) => {
  try {
    const conv = await assertParticipant(req, req.params.conversationId);
    emitToUsers(
      conv.participantIds.filter((p) => p.toString() !== String(req.user!.id)),
      'chat:typing',
      { conversationId: String(conv._id), userId: String(req.user!.id), name: req.user!.name },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Loads the conversation and proves the caller is a participant — used by every sub-route. */
async function assertParticipant(req: { user?: { id: Types.ObjectId } }, conversationId: string) {
  if (!Types.ObjectId.isValid(conversationId)) throw new HttpError(404, 'Conversation not found');
  const conv = await ChatConversation.findById(conversationId);
  if (!conv) throw new HttpError(404, 'Conversation not found');
  if (!conv.participantIds.some((p) => p.toString() === String(req.user!.id))) {
    // Guessing ids never leaks another family's conversations.
    throw new HttpError(403, 'You are not a participant of this conversation');
  }
  return conv;
}

/** Proves a target user is a member of the given family. */
async function assertFamilyMember(familyId: Types.ObjectId, userId: string): Promise<void> {
  const { FamilyMembership } = await import('../models/family');
  const membership = await FamilyMembership.findOne({ familyId, userId: new Types.ObjectId(userId) });
  if (!membership) throw new HttpError(400, 'All participants must be members of this family');
}
