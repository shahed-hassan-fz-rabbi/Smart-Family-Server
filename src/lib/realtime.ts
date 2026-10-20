import { Server } from 'socket.io';

let io: Server | null = null;

export function setIO(server: Server): void {
  io = server;
}

export function getIO(): Server | null {
  return io;
}

/** Emit an event to each user's personal room. Safe no-op if socket layer is down. */
export function emitToUsers(userIds: (string | { toString(): string })[], event: string, payload: unknown): void {
  if (!io) return;
  for (const id of userIds) {
    io.to(`user:${id.toString()}`).emit(event, payload);
  }
}
