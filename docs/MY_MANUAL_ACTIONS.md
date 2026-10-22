# My Manual Actions — Smart Family (combined checklist)

This lists **everything you personally do outside the code editor** to finish setup and deployment.
It was created by inspecting the real code — every variable below exists in the source.
You never paste secret values into any chat. Only replace the placeholders in your own files.

Estimated total time: 45–90 minutes. Do the steps **in order** — each one is needed by the next.

---

## Phase 1 — Save your work to GitHub

Local changes (the finished code including Google sign-in) are not yet committed/pushed.

- [ ] 1. In VS Code terminal, in **Smart-Family-Server** run:
      ```
      git add -A
      git commit -m "Complete server: tests, Google sign-in, docs"
      git push origin main
      ```
- [ ] 2. In **Smart-Family-Client** run the same three commands with a different commit message.
- [ ] ✅ Success: open both GitHub URLs in the browser and you can see the newest files (e.g. `README.md`, `docs/`, `src/routes/auth.ts` contains "google").

---

## Phase 2 — MongoDB Atlas (required)

- [ ] 3. Go to https://cloud.mongodb.com → sign up / log in → **Create deployment** → **M0 FREE** → pick a region near you → **Create**.
- [ ] 4. **Network Access** (left menu) → **Add IP address** → **Allow access from anywhere (0.0.0.0/0)** → Confirm (Render's servers change IP, so the open range is the practical choice for this project).
- [ ] 5. **Database Access** → **Add New Database User** → Password authentication → username (e.g. `smartfamily_app`), generate a password (**secret — save it locally**) → user privilege **readWrite** → Add user.
- [ ] 6. **Clusters → Connect → Drivers (Node.js)** → copy the **SRV connection string**.
      Edit the string: replace `<password>` with the database user's password and keep/add the database name `smart-family` before the `?`:
      ```
      mongodb+srv://smartfamily_app:YOURPASSWORD@cluster0.xxxxx.mongodb.net/smart-family?retryWrites=true&w=majority
      ```
      (**secret**) Tips: if the password has special characters, URL-encode them or regenerate a simpler one.
- [ ] 7. Create `Smart-Family-Server/.env` locally (copy of `.env.example`) and paste the string into `MONGODB_URI`.
- [ ] 8. Verify locally: in `Smart-Family-Server` run `npm run dev`, then open http://localhost:4000/api/health
      ✅ You must see `"dbConnected": true`.
- [ ] 9. (Optional, dev-only demo data) `npm run seed` creates a demo family + 2 accounts (`nusrat.demo@smartfamily.test` / `rafi.demo@smartfamily.test`, password `DemoFamily2026!`) with sample tasks and messages. Skippable — the app works fine empty. Not destructive; it only adds `[demo]`-prefixed documents.

---

## Phase 3 — Gemini AI key (required for the AI assistant)

- [ ] 10. Open https://aistudio.google.com/apikey → **Create API key** → copy (**secret**).
- [ ] 11. Put it in `Smart-Family-Server/.env` as `GEMINI_API_KEY=...` (model `GEMINI_MODEL=gemini-3.8-flash` is already the default — no change needed).
- [ ] 12. Verify: restart `npm run dev`, open the app's Assistant page, send
      "Tomorrow my mother has a doctor appointment, but I have work. Help our family organize everything."
      ✅ Expected: a proposal card with **Confirm / Cancel**. ❌ If you see "AI is not configured", the key wasn't picked up — check the `.env` spelling and restart.
- [ ] 13. Troubleshooting: `API key not valid` → re-copy the key. 429/quota → you hit the free-tier limit; wait and retry later. 503 `AI_NOT_CONFIGURED` → `GEMINI_API_KEY` missing from `.env`/Render env vars.

---

## Phase 4 — LiveKit audio/video calls (required for calls)

- [ ] 14. Open https://cloud.livekit.io → sign in with GitHub → **Create project** (free tier) → open the project's **Settings/Keys** → copy the **API Key**, **API Secret** (**secret**) and the **Websocket wss:// URL**.
- [ ] 15. In `Smart-Family-Server/.env` set: `LIVEKIT_URL=wss://...`, `LIVEKIT_API_KEY=...`, `LIVEKIT_API_SECRET=...`.
- [ ] 16. Verify: run the app in **two different browsers logged in as two family members** → start an audio call from one → accept from the other. ✅ Real voice/audio room opens. With no credentials, calls honestly report "calling not configured" — that message is expected and correct until this phase is done.

---

## Phase 5 — Google "Sign in with Google" (optional until you create the credentials)

- [ ] 17. Open https://console.cloud.google.com → create a project (top bar) → **APIs & Services → OAuth consent screen** → External → fill app name + your email → save.
- [ ] 18. **APIs & Services → Credentials → Create credentials → OAuth client ID** → Application type **Web application** →
      **Authorized redirect URIs** add exactly:
      - `http://localhost:4000/api/auth/google/callback`
      - later add your Render URL + `/api/auth/google/callback`
      Copy **Client ID** and **Client secret** (**secrets**).
- [ ] 19. In `Smart-Family-Server/.env` set `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=`.
- [ ] 20. Verify: "Sign in with Google" on the login page now completes a real sign-in. Until then the button honestly shows "not configured" when clicked — correct behavior, no fix needed.

---

## Phase 6 — Deploy the backend to Render

- [ ] 21. https://dashboard.render.com → **New → Web Service** → connect GitHub → pick the repo **Smart-Family-Server** →
      Build `npm ci && npm run build`, Start `npm start`, Health check path `/api/health` (render.yaml already encodes these).
- [ ] 22. **Environment** tab: add every server variable from Phase 2–5 (production rules):
      - `NODE_ENV=production`
      - `MONGODB_URI` (same Atlas string — **secret**)
      - `JWT_SECRET` (**secret** — make a NEW long random one for production, e.g. run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
      - `FRONTEND_URL` and `CORS_ORIGINS` = your Vercel URL (do this after Phase 7 gives you the URL; Render only needs saves to redeploy)
      - `GEMINI_API_KEY`, `LIVEKIT_URL/API_KEY/API_SECRET`, `GOOGLE_CLIENT_ID/SECRET` (**secrets**) — same values as local.
- [ ] 23. Deploy → open Render Logs → when it says "server listening", open `https://YOUR-SERVICE.onrender.com/api/health`
      ✅ Expected: `"dbConnected": true`. Then in Atlas you can see the connection from Render under **Clusters → Metrics/Current Ops**.
- [ ] 24. Add the Render callback URL in Google Console (step 18) once the URL exists.

---

## Phase 7 — Deploy the frontend to Vercel

- [ ] 25. https://vercel.com → **Add New → Project** → import GitHub repo **Smart-Family-Client** (framework auto-detects Next.js).
- [ ] 26. **Environment Variables**:
      - `NEXT_PUBLIC_API_URL` = `https://YOUR-SERVICE.onrender.com/api` (⚠ include `/api`, no trailing slash)
      - `NEXT_PUBLIC_LIVEKIT_URL` = the LiveKit wss URL (optional; the server also issues one)
- [ ] 27. Deploy → copy the URL, e.g. `https://smart-family-client.vercel.app`.
- [ ] 28. Go back to Render → Environment → set `FRONTEND_URL=https://smart-family-client.vercel.app` and `CORS_ORIGINS=https://smart-family-client.vercel.app` → **Save → Deploy** again.
- [ ] ✅ Success check: open the Vercel site → Sign up → create family → invite → second browser accepts → create a task → the assignee sees a live notification.
- [ ] 29. Test the AI assistant and a two-browser call on the deployed URLs (repeat phase 3/4 verification against production).

---

## Verification commands (local, run in VS Code terminal)

| Command (in repo root) | Success looks like |
|---|---|
| `Smart-Family-Server`: `npm run dev` | log lines: DB connected, CORS origin, listening on 4000 |
| `Smart-Family-Server`: `npm test` | `Tests  57 passed` |
| `Smart-Family-Server`: `npm run build` | no output, exit 0 |
| `Smart-Family-Client`: `npm run dev` | Local: http://localhost:3000 |
| `Smart-Family-Client`: `npm run build` | 29 routes table, no errors |

Common fixes:
- `MONGODB_URI` errors → password special characters need URL-encoding, or IP not allowed in Network Access.
- CORS errors in browser console → `CORS_ORIGINS` on Render doesn't match the exact Vercel URL.
- Google button returns "not configured" → step 17–19 not done yet.
- Calls fail "not configured" → step 14–15 not done yet.

---

## Env-var quick table (verified from source — nothing invented)

| Variable | Repo | Required | Secret | Get it from |
|---|---|---|---|---|
| `MONGODB_URI` | Server | ✅ | ✅ | Atlas → Connect → Drivers |
| `JWT_SECRET` | Server | ✅ | ✅ | generate yourself (command above) |
| `FRONTEND_URL` | Server | prod | ❌ | your Vercel URL |
| `CORS_ORIGINS` | Server | prod | ❌ | your Vercel URL |
| `GEMINI_API_KEY` | Server | for AI | ✅ | aistudio.google.com/apikey |
| `GEMINI_MODEL` | Server | optional | ❌ | default `gemini-3.8-flash` |
| `LIVEKIT_URL` | Server | for calls | ❌ | cloud.livekit.io project |
| `LIVEKIT_API_KEY` | Server | for calls | ✅ | cloud.livekit.io |
| `LIVEKIT_API_SECRET` | Server | for calls | ✅ | cloud.livekit.io |
| `GOOGLE_CLIENT_ID` | Server | optional | ✅ | console.cloud.google.com |
| `GOOGLE_CLIENT_SECRET` | Server | optional | ✅ | console.cloud.google.com |
| `NEXT_PUBLIC_API_URL` | Client | ✅ | ❌ | your Render URL + `/api` |
| `NEXT_PUBLIC_LIVEKIT_URL` | Client | optional | ❌ | LiveKit wss URL |

---

## Phase 8 � Platform Super Admin bootstrap (one per platform)

The Super Admin role is NEVER granted by signup or Google sign-in. Only this
secure server-side script can promote an admin (audited, idempotent):

1. Set ADMIN_BOOTSTRAP_TOKEN as a PRIVATE env var (32+ random chars) � locally
   in .env and later on Render (Environment ? Add, sync:false).
2. Register the future admin account through the normal app (signup page).
3. Run locally: ADMIN_BOOTSTRAP_TOKEN=<token> node scripts/create-super-admin.mjs --email <their-email> --confirm
   (on Render: use the dashboard **Shell**, keep 
pm ci && npm run build as build command).
4. The promoted admin signs in at the app and opens /admin.
5. Rotation/backup: promote a SECOND admin through the same script, then they
   can manage any future handover (demoting existing admins is intentionally
   unavailable � least privilege).

See docs/FINAL_AUDIT_REPORT.md + Platform Admin section in README.
