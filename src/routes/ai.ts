import { Router } from 'express';
import { Types } from 'mongoose';
import { AIConversation, AIProposal } from '../models/ai';
import { requireAuth } from '../middleware/auth';
import { requireFamilyMembership, HttpError } from '../middleware/familyAccess';
import { validate } from '../middleware/validate';
import { z } from 'zod';
import { buildFamilyContext } from '../services/ai/context';
import { askGemini, isAiConfigured } from '../services/ai/gemini';
import { executeConfirmedProposal } from '../services/ai/executor';
import { proposalPayloadSchema } from '../services/ai/schemas';
import { emitToUsers } from '../lib/realtime';

export const aiRouter = Router();

aiRouter.use(requireAuth);

const sendSchema = z.object({
  familyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid family id').optional(),
  content: z.string().trim().min(1).max(4000),
  conversationId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid conversation id').optional(),
});

aiRouter.post('/conversations', validate(sendSchema), async (req, res, next) => {
  try {
    const body = req.body as { content: string; familyId?: string; conversationId?: string };

    // Resolve or create the conversation — always owned by the requesting user only.
    let conversation;
    if (body.conversationId) {
      conversation = await AIConversation.findOne({
        _id: body.conversationId,
        userId: req.user!.id,
      });
      if (!conversation) throw new HttpError(404, 'Conversation not found');
    } else {
      conversation = await AIConversation.create({
        userId: req.user!.id,
        familyId: body.familyId ? new Types.ObjectId(body.familyId) : undefined,
        title: body.content.slice(0, 60),
      });
    }

    // Family context only when the conversation is bound to a family the user belongs to.
    let familyContext = null;
    if (body.familyId) {
      await requireFamilyMembership(req, body.familyId);
      familyContext = await buildFamilyContext(req.user!.id, new Types.ObjectId(body.familyId));
    }

    // Persist the user's message first.
    conversation.messages.push({ role: 'user', content: body.content, createdAt: new Date() });

    if (!isAiConfigured()) {
      conversation.messages.push({
        role: 'assistant',
        content:
          'The AI service is not configured on this server yet (missing GEMINI_API_KEY). This is a real integration point — ask the server administrator to add the key, after which full AI replies will work here.',
        createdAt: new Date(),
        meta: { providerError: true },
      });
      await conversation.save();
      res.status(503).json({
        error: 'AI_NOT_CONFIGURED',
        message: 'Gemini API key is missing on the server. The assistant awaits configuration.',
        conversationId: String(conversation._id),
        messages: conversation.messages,
      });
      return;
    }

    const history = conversation.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
    const aiReply = await askGemini(familyContext ?? emptyContext(req.user!.name), history, body.content);

    // Validate the AI proposal defensively before persisting it.
    let proposalDoc = null;
    if (aiReply.proposal) {
      if (!familyContext) {
        throw new HttpError(400, 'Family-bound proposals require a family conversation');
      }
      proposalPayloadSchema.parse(aiReply.proposal);
      conversation.messages.push({
        role: 'assistant',
        content: aiReply.reply,
        createdAt: new Date(),
        meta: { actionType: aiReply.proposal.type },
      });
      await conversation.save();
      proposalDoc = await AIProposal.create({
        conversationId: conversation._id,
        userId: req.user!.id,
        familyId: familyContext ? new Types.ObjectId(body.familyId!) : undefined,
        type: aiReply.proposal.type,
        payload: aiReply.proposal.payload,
        explanation: aiReply.reply,
        status: 'pending',
      });
    } else {
      conversation.messages.push({ role: 'assistant', content: aiReply.reply, createdAt: new Date() });
      if (aiReply.needsClarification) {
        conversation.messages.push({
          role: 'assistant',
          content: `Quick question: ${aiReply.needsClarification}`,
          createdAt: new Date(),
        });
      }
      await conversation.save();
    }

    conversation.lastMessageAt = new Date();
    await conversation.save();

    res.json({
      conversationId: String(conversation._id),
      reply: aiReply.reply,
      needsClarification: aiReply.needsClarification ?? null,
      proposal: proposalDoc
        ? {
            id: String(proposalDoc._id),
            type: proposalDoc.type,
            payload: proposalDoc.payload,
            explanation: proposalDoc.explanation,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

function emptyContext(name: string) {
  return {
    familyName: 'No family selected yet',
    members: [{ id: '', name, role: 'user' }],
    openTasks: [],
    upcomingEvents: [],
    pendingReminders: [],
    recentUpdates: [],
    currentDateTime: new Date().toISOString(),
    timezone: 'UTC',
    notes: ['No family selected — the assistant cannot see family data.'],
  };
}

aiRouter.get('/conversations', async (req, res, next) => {
  try {
    const conversations = await AIConversation.find({ userId: req.user!.id })
      .sort({ lastMessageAt: -1 })
      .limit(50)
      .select('title lastMessageAt messages')
      .lean();
    res.json({
      conversations: conversations.map((c) => ({
        id: String(c._id),
        title: c.title,
        lastMessageAt: c.lastMessageAt,
        messageCount: c.messages.length,
        preview: c.messages.at(-1)?.content?.slice(0, 120) ?? '',
      })),
    });
  } catch (err) {
    next(err);
  }
});

aiRouter.get('/conversations/:id', async (req, res, next) => {
  try {
    const conversation = await AIConversation.findOne({
      _id: req.params.id,
      userId: req.user!.id, // AI conversations are strictly personal
    }).lean();
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    res.json({
      conversation: {
        id: String(conversation._id),
        title: conversation.title,
        familyId: conversation.familyId ? String(conversation.familyId) : null,
        messages: conversation.messages,
      },
    });
  } catch (err) {
    next(err);
  }
});

aiRouter.delete('/conversations/:id', async (req, res, next) => {
  try {
    const result = await AIConversation.deleteOne({ _id: req.params.id, userId: req.user!.id });
    if (result.deletedCount === 0) throw new HttpError(404, 'Conversation not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Confirming a proposal is the ONLY path to executing an AI action. */
aiRouter.post('/actions/:proposalId/confirm', async (req, res, next) => {
  try {
    const result = await executeConfirmedProposal(req.params.proposalId, req.user!.id);
    res.json({ ok: true, type: result.type, result: result.result });
  } catch (err) {
    next(err);
  }
});

aiRouter.post('/actions/:proposalId/cancel', async (req, res, next) => {
  try {
    // Atomic cancel: racing confirm/cancel requests cannot both win.
    const updated = await AIProposal.findOneAndUpdate(
      { _id: req.params.proposalId, userId: req.user!.id, status: 'pending' },
      { $set: { status: 'cancelled' } },
      { new: true },
    );
    if (!updated) throw new HttpError(404, 'Proposal not found or already handled');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Capability listing for the UI prompt suggestions. */
aiRouter.get('/capabilities', (_req, res) => {
  res.json({
    capabilities: [
      { type: 'create_task', label: 'Create a family task' },
      { type: 'update_task', label: 'Update or complete a task' },
      { type: 'propose_event', label: 'Propose a calendar event' },
      { type: 'create_reminder', label: 'Create a reminder (including recurring)' },
      { type: 'create_checklist', label: 'Create a preparation checklist' },
      { type: 'draft_message', label: 'Draft a family chat message' },
    ],
  });
});
