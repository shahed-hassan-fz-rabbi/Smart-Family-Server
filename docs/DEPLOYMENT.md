# Deploying Smart Family Server to Render

This guide deploys the Smart Family API to [Render](https://render.com) with MongoDB Atlas. It describes only steps that are verifiable from this repository — no deployment has been run yet, so nothing here claims a live URL.

## 1. MongoDB Atlas

1. Create a free **M0** cluster.
2. **Database Access** → create a user. Least-privilege works: `readWrite` on the `smart-family` database.
3. **Network Access** → `0.0.0.0/0` is practical for Render because its egress IPs rotate. Restricting IP ranges is stronger if you know them.
4. Copy the SRV string, e.g.
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/smart-family?retryWrites=true&w=majority`
   — keep the `/smart-family` database name segment.

## 2. Render web service

1. **New → Web Service**, connect the GitHub repo `Smart-Family-Server`.
2. Runtime **Node**; build & start commands (already encoded in `render.yaml`):
   - Build: `npm ci && npm run build`
   - Start: `npm start`
   - Health check path: `/api/health`
3. Instance type: free tier works for a single instance. **Do not** scale to multiple instances without adding a Socket.IO adapter (Redis) and a scheduler lock — reminders and real-time delivery assume one process.

## 3. Environment variables (Render dashboard → Environment)

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | ✅ | `production` |
| `MONGODB_URI` | ✅ | Atlas SRV string from step 1 |
| `JWT_SECRET` | ✅ | `openssl rand -hex 32`, rotate if leaked |
| `PORT` | — | Render injects it automatically |
| `FRONTEND_URL` | ✅ | Your Vercel URL, e.g. `https://smart-family-client.vercel.app` |
| `CORS_ORIGINS` | ✅ | Same value(s), comma-separated if multiple (falls back to `FRONTEND_URL`) |
| `GEMINI_API_KEY` | optional | Enables the AI assistant. Without it AI routes return `503 AI_NOT_CONFIGURED` (honest, by design) |
| `GEMINI_MODEL` | optional | Defaults to `gemini-2.0-flash` |
| `LIVEKIT_URL` | optional | `wss://...` — enables calling. Without it call tokens return `503 CALLING_NOT_CONFIGURED` |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | optional | From LiveKit cloud project keys |
| `JWT_EXPIRES_IN_DAYS` | optional | Defaults to `30` |
| `LOG_LEVEL` | optional | `debug` \| `info` \| `warn` \| `error` (default `info`) |

Rate limits are defined in `src/app.ts` (60 requests / 15 min on auth, 300 / min on the API) and are not env-configurable yet — see Future improvements in the README.

Secrets go in the Render dashboard only — never in Git. `.env.example` documents every variable the server reads.

## 4. Deploy & verify

Trigger the first deploy, then verify without trusting any single check:

```bash
curl https://YOUR-SERVICE.onrender.com/api/health
# expect: {"dbConnected":true,"aiConfigured":false,"livekitConfigured":false,...}
```

- `aiConfigured:false` / `livekitConfigured:false` are honest signals — set the keys above to flip them.
- Then exercise a real flow from the deployed frontend: register → create family → invite (copy link) → second browser accepts → create a task → confirm the notification appears for the assignee.

## 5. Frontend counterpart

Deploy `Smart-Family-Client` to Vercel first or second; the only server-side requirement is that `CORS_ORIGINS` includes the final Vercel URL. The client env vars and steps are in the client repo's `README.md`.

## Rollback & operational notes

- Render keeps previous deploys — roll back from the dashboard if a release misbehaves.
- Logs are structured (pino) with redaction of passwords/tokens/cookies.
- The reminder scheduler runs in-process (`node-cron`) with a restart catch-up query, so missed reminders fire shortly after boot; it does not need a separate worker on single-instance setups.
