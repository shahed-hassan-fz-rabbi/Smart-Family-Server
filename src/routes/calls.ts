import { Router } from 'express';
import { Types } from 'mongoose';
import { CallSession } from '../models/safety';
import { ChatConversation } from '../models/chat';
import { requireAuth } from '../middleware/auth';
import { requireFamilyMembership, HttpError } from '../middleware/familyAccess';
import { validate } from '../middleware/validate';
import { createCallSchema } from '../validators/safety';
import { config } from '../config/env';
import { createNotification } from '../services/notification';
import { expireStaleRingingCalls } from '../services/callSweeper';
import { emitToUsers } from '../lib/realtime';
import { logger } from '../config/logger';

export const callsRouter = Router();

callsRouter.use(requireAuth);

callsRouter.post('/', validate(createCallSchema), async (req, res, next) => {
  try {
    // Expired rings become `missed` first, so the conflict check below is
    // always evaluated against genuinely ringing sessions.
    await expireStaleRingingCalls();

    const { familyId } = await requireFamilyMembership(req, req.body.familyId);

    if (req.body.conversationId) {
      const conv = await ChatConversation.findById(req.body.conversationId);
      if (!conv || String(conv.familyId) !== String(familyId) || !conv.participantIds.some((p) => p.toString() === String(req.user!.id))) {
        throw new HttpError(403, 'You are not a participant of the linked conversation');
      }
    }

    // Every participant must be in the same family.
    const participants = Array.from(new Set([String(req.user!.id), ...req.body.participantIds.map(String)]));
    const tokens = await Promise.all(
      participants.map(async (userId) => {
        const membership = await requireFamilyMembership({ user: { id: new Types.ObjectId(userId) } } as never, String(familyId));
        void membership;
      }),
    );
    void tokens;

    // Lifecycle safety: a participant who is already being rung by another
    // session must not get a second simultaneous incoming call.
    const calleeIds = participants.filter((p) => p !== String(req.user!.id));
    for (const calleeId of calleeIds) {
      const clash = await CallSession.exists({
        status: 'ringing',
        participants: { $elemMatch: { userId: new Types.ObjectId(calleeId) } },
      });
      if (clash) {
        throw new HttpError(
          409,
          'This person already has an incoming call ringing. Wait for that call to be answered or declined first.',
        );
      }
    }

    const call = await CallSession.create({
      familyId,
      conversationId: req.body.conversationId,
      mode: req.body.mode,
      status: 'ringing',
      initiatorId: req.user!.id,
      participants: participants.map((id) => ({ userId: new Types.ObjectId(id) })),
    });
    logger.info(
      { callId: String(call._id), mode: call.mode, participantCount: participants.length, initiatorId: String(req.user!.id) },
      'call created — ringing',
    );

    for (const calleeId of calleeIds) {
      await createNotification({
        userId: new Types.ObjectId(calleeId),
        familyId,
        type: 'call_incoming',
        title: `Incoming ${req.body.mode} call from ${req.user!.name}`,
        linkPath: `/calls/${String(call._id)}`,
        refType: 'call',
        refId: call._id as Types.ObjectId,
        dedupeKey: `call-ring-${call._id}-${calleeId}`,
      });
    }
    emitToUsers(calleeIds, 'call:incoming', {
      callId: String(call._id),
      mode: call.mode,
      from: req.user!.name,
      fromId: String(req.user!.id),
    });

    res.status(201).json({ call: { id: String(call._id), mode: call.mode, status: call.status } });
  } catch (err) {
    next(err);
  }
});

/** Issues a LiveKit room token after re-verifying membership. Honest errors when unconfigured. */
callsRouter.get('/:callId/token', async (req, res, next) => {
  try {
    // A ring nobody answered within its window must become `missed` before we
    // decide whether a token can still be issued for it.
    await expireStaleRingingCalls();

    const call = await CallSession.findById(req.params.callId);
    if (!call) throw new HttpError(404, 'Call not found');
    const { familyId } = await requireFamilyMembership(req, String(call.familyId));
    if (!call.participants.some((p) => p.userId.toString() === String(req.user!.id))) {
      throw new HttpError(403, 'You are not a participant of this call');
    }

    // Lifecycle safety: tokens are only valid for calls that can actually be
    // joined — never for already ended, declined or missed sessions.
    if (call.status !== 'ringing' && call.status !== 'active') {
      throw new HttpError(410, 'This call has ended and can no longer be joined.');
    }

    if (!config.livekit.enabled) {
      logger.warn({ callId: String(call._id), userId: String(req.user!.id) }, 'call token refused — livekit not configured');
      res.status(503).json({
        error: 'CALLING_NOT_CONFIGURED',
        message:
          'LiveKit is not configured on this server yet (needs LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET). Call tokens cannot be issued until configuration is completed.',
      });
      return;
    }

    const { AccessToken } = await import('livekit-server-sdk');
    const identity = String(req.user!.id);
    const roomName = `family-${String(familyId)}-call-${String(call._id)}`;
    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity,
      name: req.user!.name,
      ttl: '2h',
    });
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    if (call.status === 'ringing') {
      call.status = 'active';
    }
    const participant = call.participants.find((p) => p.userId.toString() === identity);
    if (participant && !participant.joinedAt) participant.joinedAt = new Date();
    await call.save();

    // livekit-server-sdk v2.x: toJwt() is asynchronous — must be awaited,
    // otherwise the Promise serializes as {} and the client cannot join.
    const jwt = await token.toJwt();
    logger.info(
      { callId: String(call._id), userId: identity, room: roomName, mode: call.mode },
      'call token issued',
    );
    res.json({
      token: jwt,
      url: config.livekit.url,
      room: roomName,
      mode: call.mode,
    });
  } catch (err) {
    next(err);
  }
});

callsRouter.post('/:callId/decline', async (req, res, next) => {
  try {
    const call = await CallSession.findById(req.params.callId);
    if (!call) throw new HttpError(404, 'Call not found');
    if (!call.participants.some((p) => p.userId.toString() === String(req.user!.id))) {
      throw new HttpError(403, 'You are not a participant of this call');
    }
    call.status = 'declined';
    call.endedAt = new Date();
    await call.save();
    emitToUsers([call.initiatorId], 'call:declined', { callId: String(call._id) });
    logger.info({ callId: String(call._id), userId: String(req.user!.id) }, 'call declined');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

callsRouter.post('/:callId/end', async (req, res, next) => {
  try {
    const call = await CallSession.findById(req.params.callId);
    if (!call) throw new HttpError(404, 'Call not found');
    if (!call.participants.some((p) => p.userId.toString() === String(req.user!.id))) {
      throw new HttpError(403, 'You are not a participant of this call');
    }
    call.status = 'ended';
    call.endedAt = new Date();
    const p = call.participants.find((x) => x.userId.toString() === String(req.user!.id));
    if (p) p.leftAt = new Date();
    await call.save();
    emitToUsers(
      call.participants.map((x) => x.userId),
      'call:ended',
      { callId: String(call._id) },
    );
    logger.info({ callId: String(call._id) }, 'Call ended');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

callsRouter.get('/', async (req, res, next) => {
  try {
    const familyId = req.query.familyId as string | undefined;
    if (!familyId) throw new HttpError(400, 'familyId query parameter is required');
    await requireFamilyMembership(req, familyId);
    const calls = await CallSession.find({
      familyId: new Types.ObjectId(familyId),
      participants: { $elemMatch: { userId: req.user!.id } },
    })
      .sort({ startedAt: -1 })
      .limit(30)
      .lean();
    res.json({
      calls: calls.map((c) => ({
        id: String(c._id),
        mode: c.mode,
        status: c.status,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        isInitiator: String(c.initiatorId) === String(req.user!.id),
        participantCount: c.participants.length,
      })),
    });
  } catch (err) {
    next(err);
  }
});
