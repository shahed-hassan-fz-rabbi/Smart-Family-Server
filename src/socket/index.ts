import { Server as HttpServer } from 'http';
import { Server as IOServer } from 'socket.io';
import { config } from '../config/env';
import { verifySessionToken, SESSION_COOKIE_NAME } from '../lib/token';
import { User } from '../models/user';
import { logger } from '../config/logger';
import { ChatConversation } from '../models/chat';
import { Types } from 'mongoose';

/**
 * Socket.IO layer.
 *
 * Security model:
 * - Handshake authentication: JWT session cookie (same cookie as REST).
 * - `conversation:join` verifies the user is a participant before joining.
 * - Only server-verified user ids are trusted; clients cannot impersonate.
 * - Message creation happens over REST (validated + persisted); sockets only
 *   deliver events, typing indicators and presence.
 */
const onlineUsers = new Set<string>();
/** How many sockets (devices/tabs) each user currently has — an offline event
 *  must only fire when the LAST session of a user goes away. */
const sessionsByUser = new Map<string, number>();

export function initSocket(httpServer: HttpServer): IOServer {
  const io = new IOServer(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie ?? '';
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map((c) => {
          const idx = c.indexOf('=');
          return [c.slice(0, idx).trim(), decodeURIComponent(c.slice(idx + 1).trim())];
        }),
      );
      const token = cookies[SESSION_COOKIE_NAME];
      const payload = token ? verifySessionToken(token) : socket.handshake.auth?.token ? verifySessionToken(String(socket.handshake.auth.token)) : null;
      if (!payload) {
        next(new Error('Unauthorized socket connection'));
        return;
      }
      socket.data.userId = payload.sub;
      next();
    } catch {
      next(new Error('Unauthorized socket connection'));
    }
  });

  io.on('connection', (socket) => {
    const userId = String(socket.data.userId);
    socket.join(`user:${userId}`);
    onlineUsers.add(userId);
    sessionsByUser.set(userId, (sessionsByUser.get(userId) ?? 0) + 1);

    socket.on('conversation:join', async (conversationId: string, callback?: (ok: boolean | { error: string }) => void) => {
      try {
        if (typeof conversationId !== 'string' || !Types.ObjectId.isValid(conversationId)) {
          typeof callback === 'function' && callback({ error: 'Invalid conversation' });
          return;
        }
        const conv = await ChatConversation.findById(conversationId).select('participantIds');
        if (!conv || !conv.participantIds.some((p) => p.toString() === userId)) {
          typeof callback === 'function' && callback({ error: 'Not a participant' });
          return;
        }
        await socket.join(`conversation:${conversationId}`);
        socket.to(`conversation:${conversationId}`).emit('presence:online', { userId });
        typeof callback === 'function' && callback(true);
      } catch {
        typeof callback === 'function' && callback({ error: 'Join failed' });
      }
    });

    socket.on('conversation:leave', (conversationId: string) => {
      if (typeof conversationId === 'string') {
        socket.leave(`conversation:${conversationId}`);
      }
    });

    socket.on('chat:typing', (payload: { conversationId?: string }) => {
      const conversationId = payload?.conversationId;
      if (typeof conversationId !== 'string' || !socket.rooms.has(`conversation:${conversationId}`)) return;
      socket.to(`conversation:${conversationId}`).emit('chat:typing', { userId, name: socket.data.name ?? userId });
    });

    // Use `disconnecting` (not `disconnect`): by the time `disconnect` fires,
    // Socket.IO has already removed the socket from its rooms — we still need
    // the joined conversation list for the privacy-preserving presence emit.
    socket.on('disconnecting', () => {
      const joinedRooms = Array.from(socket.rooms).filter((r) => r.startsWith('conversation:'));
      const remaining = (sessionsByUser.get(userId) ?? 1) - 1;
      if (remaining > 0) {
        sessionsByUser.set(userId, remaining);
        void joinedRooms;
        return; // another device/tab of this user is still around
      }
      sessionsByUser.delete(userId);
      onlineUsers.delete(userId);

      // Privacy-preserving presence: the offline event goes ONLY to the
      // conversation rooms this socket actually joined — verified participants
      // — never as a global broadcast (which previously leaked presence
      // across unrelated families).
      for (const room of joinedRooms) {
        io.to(room).emit('presence:offline', { userId });
      }
    });
  });

  logger.info('Socket.IO initialized');
  return io;
}

export function isUserOnline(userId: string): boolean {
  return onlineUsers.has(userId);
}
