# Smart Family — Final Audit Report

Date: 2026-10-20
Auditor: with user present (all commands run locally against the real repositories)

Legend: **PASS** = verified with a real run · **FAIL** = reproducible problem (fixed below) ·
**BLOCKED** = needs credentials / manual setup · **NOT TESTED** = no safe test path yet.

No secrets are included in this report.

---

## 1. Version control state — PASS

| Check | Command | Observed result |
|---|---|---|
| Server repo synced | `git fetch origin; git status -sb` | `## main...origin/main` (no ahead/behind) — last commit `66fc016 "login with google is added"` |
| Client repo synced | `git fetch origin; git status -sb` | `## main...origin/main` — last commit `ead7710 "google login is added"` |
| No secrets tracked (server) | `git ls-files \| Select-String "\.env"` | only `.env.example` |
| No secrets tracked (client) | same | only `.env.example` |

## 2. Backend (Smart-Family-Server) — PASS (after 2 fixes, see §4)

| Check | Command | Observed result |
|---|---|---|
| Type check | `npx tsc --noEmit` | exit code 0 |
| Full test suite (unit + integration vs real in-memory MongoDB + real Socket.IO) | `npx vitest run` | **57 passed (57), 0 failed**, exit 0 |
| TypeScript production build | `npm run build` (tsc) | exit 0 |
| Boot of built artifact vs ephemeral MongoDB | `node scripts/boot-smoke.mjs` | "BOOT SMOKE TEST PASSED — built server listens, connects, and reports health" (health 200) |
| Live server vs user's real Atlas | `GET http://localhost:4000/api/health` | HTTP 200 — `dbConnected:true`, `aiConfigured:true`, `livekitConfigured:false` (honest: LiveKit not yet set up) |
| Real end-to-end AI request | script: register → login → create family → `POST /api/ai/conversations` | register 201, login 200, family 201, **AI 200 with a real Gemini reply + `proposal` object** |
| Real end-to-end notifications read | `GET /api/notifications` (authenticated) | 200 |

Test-suite isolation fix: the suite now pins `GEMINI_API_KEY=''`, `GOOGLE_CLIENT_ID=''`,
`GOOGLE_CLIENT_SECRET=''`, `LIVEKIT_*=''` in `test/integration.test.ts` before importing `src`,
so a developer's real `.env` cannot flip the "honestly not configured" tests (dotenv only fills
**unset** variables).

## 3. Frontend (Smart-Family-Client) — PASS (after 1 fix, see §4)

| Check | Command | Observed result |
|---|---|---|
| Type check | `npx tsc --noEmit` (after removing stale `.next/types`) | exit 0 |
| Production build | `npm run build` | "Compiled successfully", 30/30 static pages generated, exit 0 |

## 4. FAILs found during audit → fixes → re-verification

1. **FAIL — Client layout exported `BrandMark`.** Next.js only allows specific exports from
   `app` layouts; `npx tsc --noEmit` failed with
   `Property 'BrandMark' is incompatible with index signature` (detached `Component` export).
   *Fix (minimal):* removed the exported `BrandMark` from `src/app/(app)/layout.tsx` and imported
   the existing shared `src/components/BrandMark.tsx` instead. Layout renders identically.
   *Re-verified:* client `tsc` exit 0 + production build 30/30 pages.
2. **FAIL — Backend tests polluted by a real `.env`.** After the developer added a live
   `GEMINI_API_KEY` to their local `.env`, 5 tests that verify the honest
   "not configured" behavior failed (health, `/auth/providers`, `/auth/google` redirect, AI 503,
   LiveKit 503). *Fix (minimal):* pre-set empty values for `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `LIVEKIT_URL/API_KEY/API_SECRET` at the top of
   `test/integration.test.ts` *before* the dynamic `src` imports. No `.env` or production code changed.
   *Re-verified:* 57/57 tests pass.
3. **FAIL (PRODUCTION SEVERITY) — Gemini model discontinued.** A real AI request through the
   running backend returned **502**; server logs showed Google's 404:
   `models/gemini-2.0-flash is no longer available … use models/gemini-3.8-flash`.
   *Verification of available models:* called the Google ListModels endpoint using the locally
   configured key (key never printed); `gemini-3.8-flash` is present in the list.
   *Fix (minimal):* default `GEMINI_MODEL` changed from `gemini-2.0-flash` to `gemini-3.8-flash`
   in `src/config/env.ts`; local `.env` override updated (value is not a secret); docs +
   `.env.example` aligned.
   *Re-verified (real e2e):* register 201 → login 200 → family 201 → **AI 200 with a genuine
   reply** ("Here is a simple plan to help coordinate your mother's appointment…") and a
   `proposal` object + `conversationId` returned.

## 5. Verified working end-to-end (real requests, real database)

- Registration, login, session cookie (201/200)
- Family creation (201)
- AI conversation with Gemini reply + proposal (200)
- Notifications list (200)
- Health endpoint with DB connectivity (200)
- Socket.IO server starts alongside API (boot smoke + dev logs)

## 6. BLOCKED — waiting on manual setup / credentials (start commands already verified)

| Item | Why blocked | Where it will be evidenced |
|---|---|---|
| LiveKit calling | No `LIVEKIT_URL/API_KEY/API_SECRET` yet — backend honestly returns 503 and logs a warning | After keys: real call-token request returns 200; two-browser call test |
| Google OAuth sign-in | No `GOOGLE_CLIENT_ID/SECRET` yet — button stays visible and honestly reports "not configured" | After keys: browser completes Google round-trip and logs in |
| Render deployment | Not created yet (needs GitHub push of the audit fixes first) | `GET <render-url>/api/health` returns 200 with `dbConnected:true` |
| Vercel deployment | Not created yet | Live frontend URL loads and reaches the Render backend |
| Production CORS/WebSocket/OAuth callback URLs | URL names cannot be invented before the Render/Vercel URLs exist | After deploy: update `FRONTEND_URL`, `NEXT_PUBLIC_API_URL`, Google redirect URIs |

## 7. Honest limitations / NOT TESTED

- Real two-device call flow: blocked until LiveKit keys exist (NOT TESTED — no fake evidence).
- Email delivery / password-reset emails: the project has no email provider dependency in
  its env schema (reset flows return one-time tokens in the API response for development) —
  safe for a family app, documented honestly.
- Reminder scheduler watermark logic is covered by unit/integration tests (PASS), but
  scheduler behavior across long uptime (multi-day) is NOT TESTED.

## 8. Local uncommitted changes made by this audit

Server: `src/config/env.ts` (model default), `test/integration.test.ts` (env isolation),
`.env.example` + `README.md` + `docs/DEPLOYMENT.md` + `docs/MY_MANUAL_ACTIONS.md` (model name).
Client: `src/app/(app)/layout.tsx` (BrandMark import).
These must be committed and pushed before Render/Vercel will pick them up.
