# Smart Family — Server

**AI-Powered Family Care, Communication & Safety Platform** — REST API + real-time backend.

> One Family. One Platform. Smarter Care with AI.

This repository contains the backend for Smart Family: an Express + TypeScript API with MongoDB (Mongoose), Socket.IO real-time messaging, a Gemini-powered AI assistant with a validated action-proposal workflow, a LiveKit calling integration path, and server-side reminder scheduling.

**Companion frontend:** [Smart-Family-Client](https://github.com/shahed-hassan-fz-rabbi/Smart-Family-Client) (Next.js, deploys to Vercel).

## Problems solved

Smart Family coordinates real family life — appointments, care tasks, reminders, communication — instead of being another generic chatbot. The AI assistant understands family problems in **English, Bangla, and Banglish**, retrieves only authorized family context, proposes concrete actions, and executes them through validated backend services **only after the user confirms**.

## Features (implemented)

| Area | Status |
|---|---|
| Auth: register / login / logout / me / password reset (`bcrypt`, HttpOnly cookie session, JWT) | ✅ |
| Family space: create, update, members, roles (`owner`/`admin`/`member`), invitations (hashed, expiring, single-use), leave/remove | ✅ |
| Tasks: CRUD, assignment, priority, due dates, status, filters, notification on assignment/completion | ✅ |
| Calendar: events CRUD, validation, participant invites, conflict detection endpoint | ✅ |
| Reminders: CRUD, recurrence (daily/weekly/monthly), server-side `node-cron` scheduler with restart catch-up | ✅ in-app only |
| Notifications: persisted, dedup keys, live Socket.IO delivery, read / read-all | ✅ in-app only |
| AI assistant: Gemini (`@google/genai`), strict JSON replies, 6 typed action proposals, confirm/cancel/execute flow, authorized-context builder | ✅ needs `GEMINI_API_KEY` |
| Family chat: DM + group conversations, REST message persistence, Socket.IO delivery, typing, unread counts, read receipts, dedupe on reconnect | ✅ |
| Calls: LiveKit server-side token issuance with membership checks, call lifecycle recording | ✅ needs LiveKit credentials |
| Safety: emergency contacts, explicit SOS handoff, consent-based location flag | ✅ honest limits |
| Health & wellbeing resources, updates feed, profile / privacy / account deletion | ✅ |

What is **not** implemented (and never falsely claimed): email delivery, push notifications, call recording, automatic emergency dispatch, covert location tracking.

## Tech stack

- Node.js 18+, Express 4, TypeScript (strict)
- MongoDB Atlas + Mongoose 8
- Socket.IO 4 (cookie-authenticated)
- `@google/genai` (Gemini), `livekit-server-sdk`
- Zod validation everywhere (routes + AI payloads)
- `helmet`, `cors`, `express-rate-limit`, `cookie-parser`, `pino` (redacted logging)
- Vitest (unit + full-stack integration tests against in-memory MongoDB)

## Project structure

```
src/
  config/        env validation (zod), logger
  db/            MongoDB connection
  models/        User, Family(+Membership+Invitation), Task, CalendarEvent,
                 Reminder, Notification, AI(+Proposal), Chat(+Message),
                 CallSession/Emergency/FamilyUpdate, PasswordReset
  middleware/    requireAuth, family authorization (familyAccess), zod validate, error handler
  routes/        auth, users, families, tasks, calendar, reminders,
                 notifications, ai, conversations, calls, safety
  services/      notification, reminderScheduler, ai/{gemini,context,executor,schemas}
  socket/        Socket.IO init + authorization
  seed/          demo seed (npm run seed)
  types/         shared HTTP types
  index.ts       entrypoint (HTTP + Socket.IO + scheduler + graceful shutdown)
  app.ts         express app assembly
test/            unit + integration tests
```

## Getting started

```bash
npm install
cp .env.example .env       # then fill MONGODB_URI + JWT_SECRET
npm run dev                # http://localhost:4000
```

### Environment variables (`.env`)

See `.env.example`. Required: `MONGODB_URI`, `JWT_SECRET`. Optional but feature-gating: `GEMINI_API_KEY` (AI assistant), `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` (calls). `FRONTEND_URL` / `CORS_ORIGINS` for CORS.

### MongoDB Atlas setup

1. Create a free [Atlas](https://www.mongodb.com/atlas) cluster.
2. Create a database user (use least privileges: `readWrite` on the `smart-family` database only).
3. Network access: add your dev IP, or `0.0.0.0/0` for Render (its egress IPs rotate).
4. Copy the SRV connection string into `MONGODB_URI` (kepp the `/smart-family` database name).

### Demo seed

```bash
npm run seed               # creates [demo] family + 2 accounts + realistic data
```

Demo accounts (development only, `DemoFamily2026!`): `nusrat.demo@smartfamily.test`, `rafi.demo@smartfamily.test`.

## API overview

| Method & path | Purpose |
|---|---|
| `POST /api/auth/register` · `login` · `logout` · `forgot-password` · `reset-password` | session lifecycle |
| `GET /api/auth/me` | current user |
| `GET/POST /api/families`, `GET/PATCH /api/families/:id` | family space |
| `POST/GET/DELETE /api/families/:id/invitations(/.../:inviteId)`, `POST /api/families/invitations/accept` | invitations |
| `PATCH/DELETE /api/families/:id/members/:mid` · `/members/me` | member management |
| `GET/POST/PATCH/DELETE /api/tasks` | tasks (family-scoped) |
| `GET/POST/PATCH/DELETE /api/calendar/events`, `GET /api/calendar/events/conflicts` | calendar |
| `GET/POST/PATCH/DELETE /api/reminders` | reminders |
| `GET/POST /api/notifications(/read|/read-all)` | notifications |
| `POST/GET/DELETE /api/ai/conversations(/:id)`, `POST /api/ai/actions/:id/confirm|cancel`, `GET /api/ai/capabilities` | AI assistant |
| `GET/POST /api/conversations` · `/:id` · `/:id/messages` · `/:id/read` · `/:id/typing` | family chat |
| `POST/GET /api/calls`, `GET /api/calls/:id/token`, `POST /api/calls/:id/decline|end` | calling |
| `POST /api/:familyId/sos` | SOS handoff |
| `GET/POST/DELETE /api/:familyId/emergency-contacts` · `/:familyId/updates` | safety + updates |
| `GET/PATCH/DELETE /api/users/me` | profile/preferences/account |
| `GET /api/health` | health check (db/AI/LiveKit status) |

All list reads require `familyId` and verify membership server-side; sender/user identity always comes from the session, never the request body.

## Real-time (Socket.IO)

- Handshake authenticates the session cookie (`credentials: include` from the browser).
- `conversation:join` verifies conversation membership before joining the room.
- `chat:new-message`, `chat:typing`, `chat:read`, `notification:new`, `call:incoming|declined|ended`, `safety:sos` events.
- Messages are created over REST (validation + persistence + dedupe); sockets only deliver — no untrusted client sender ids.

**Deployment note:** a single Render web service supports this Socket.IO setup. Do not split the API across multiple instances without adding a socket adapter (e.g. Redis).

## Gemini AI setup

1. Get a key at [Google AI Studio](https://aistudio.google.com/apikey).
2. Set `GEMINI_API_KEY` (server-side only — never in the frontend) and optionally `GEMINI_MODEL` (default `gemini-2.0-flash`).
3. Without a key, AI routes respond `503 AI_NOT_CONFIGURED` and persist an honest fallback message — the app never fakes AI output.

The action flow: message → authorized context → Gemini structured JSON → Zod-validated proposal → persisted as `AIProposal` → user Confirm/Edit/Cancel → backend re-authorization + Zod re-validation → execution via the same services used by manual actions → real result reported.

## LiveKit calling setup

1. Create a project at [LiveKit Cloud](https://cloud.livekit.io).
2. Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` on the server.
3. Set `NEXT_PUBLIC_LIVEKIT_URL` (the `wss://` URL) on the frontend if it differs from the API origin.
4. Tokens are issued only to call participants after membership verification; rooms are scoped per call.

## Testing

```bash
npm test            # all tests (unit + integration; the integration part downloads a
                    # MongoDB binary once on a fresh machine, then it is cached)
node scripts/boot-smoke.mjs   # boots the built server (dist/index.js) against an
                              # ephemeral MongoDB and verifies /api/health
```

The integration suite covers registration/login/session, family authorization boundaries (401/403 by construction, not by id), task/calendar/reminder validation, leave-family routing, the honest `AI_NOT_CONFIGURED` fallback, real-time chat delivery over Socket.IO (cookie-authenticated handshake), call-token authorization, and conflict detection. It uses in-memory MongoDB — no Atlas data is touched. The boot smoke test verifies the exact production artifact end to end (env validation → DB connect → scheduler → Socket.IO → listening).

## Deployment (Render)

See `render.yaml` and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Briefly:

- **Build** `npm ci && npm run build`, **start** `npm start`, health check `/api/health`.
- Set env vars (never commit secrets). Connect MongoDB Atlas. Configure `CORS_ORIGINS` with your Vercel URL.

## Security notes & known limitations

- Passwords hashed with bcrypt(12); sessions in HttpOnly SameSite=Lax cookies (Secure in production).
- Authorization enforced in middleware/services on every read and write — changing document IDs in the URL never grants access.
- Password reset tokens stored hashed, single-use, 1-hour expiry. Email delivery is not implemented — deliver reset tokens out-of-band (documented in the API response).
- Rate limits: 60/15min on auth, 300/min on all API.
- Production errors hide stack traces; logs redact passwords/tokens/cookies.
- Known limitations: single-instance scheduling (fine for one Render service), no file attachments, no email/push delivery, AI actions limited to 6 typed operations, calls require LiveKit configuration.

## Future improvements

Email delivery (e.g. Resend), push notifications, Redis-backed socket adapter + multi-instance scheduler lock, attachments in chats with malware scanning, AI conversation summarization, i18n for non-assistant UI copy.
