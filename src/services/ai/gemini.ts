import { GoogleGenAI, type GenerateContentParameters } from '@google/genai';
import { config } from '../../config/env';
import { HttpError } from '../../middleware/familyAccess';
import { logger } from '../../config/logger';
import { AiReply, aiReplySchema } from './schemas';
import { FamilyContext, summarizeContextForLog } from './context';

/**
 * Provider latency right now is high (measured 2026-10-23: simple turns ~55s,
 * family-context turns ~92s — and >120 s in demand spikes, while
 * `gemini-3.5-flash` answered in ~2 s during the same burst). The old 30 s cap
 * expired before Gemini ever answered. Supported models are verified against
 * ListModels, so the time/fallback policy is the knob — not the model name.
 */
const AI_TIMEOUT_MS = 120_000; // per attempt
const MAX_TOTAL_BUDGET_MS = 300_000; // hard wall-clock cap for the whole turn
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** Retry ceilings per failure class; timeouts only get ONE retry because a
 *  second 120s attempt doubles an already long wait. */
const MAX_RETRIES: Record<ProviderErrorKind, number> = {
  transient: 2,
  timeout: 1,
  malformed: 2,
  fatal: 0,
};
type ProviderErrorKind = 'transient' | 'timeout' | 'malformed' | 'fatal';

/**
 * Demand-spike fallback. `gemini-3.8-flash` (primary, set via GEMINI_MODEL)
 * is verified valid but occasionally saturates for minutes at a time while
 * `gemini-3.5-flash` keeps answering. If the primary's bounded retries are
 * exhausted for a retryable reason, the turn switches models once instead of
 * failing. Fatal errors (bad key / bad model config) never switch — they need
 * an administrator, not a different model.
 */
const FALLBACK_MODEL = 'gemini-3.5-flash';

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI | null {
  if (!config.gemini.enabled) return null;
  if (!client) client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return client;
}

export function isAiConfigured(): boolean {
  return config.gemini.enabled;
}

function buildSystemInstruction(ctx: FamilyContext): string {
  return `You are "Smart Family Assistant", an AI helper inside Smart Family, an app that helps families coordinate care, tasks, calendars, reminders and communication.

Your capabilities:
- Understand family coordination problems in English, Bangla, and common Banglish ("romaji-like" Bangla written in Latin letters).
- Reply in the language the user wrote in (Bangla input → Bangla reply; Banglish input → Banglish or Bangla reply; English input → English reply).
- Extract dates, times, people and tasks when clearly given. Convert relative dates ("tomorrow", "next Sunday", "kalke") into absolute ISO-8601 UTC datetimes using the current date/time below.
- Ask ONE short clarifying question ONLY when an essential detail (such as a time, date, or assignment target) is missing. Never invent family details, schedules, or availability.
- Propose a single concrete action proposal when the user's intent is clear, via the "proposal" field.

STRICT RULES:
- You are NOT a doctor. Never diagnose, never prescribe. For urgent health or safety problems, advise contacting local emergency services or qualified professionals.
- You cannot execute anything yourself. The user must confirm proposals in the app.
- Never claim an action has been completed.
- Use only the authorized family context provided below. Never invent tasks, events, names, or availability that are not in it.
- Output STRICT JSON only, matching this schema exactly:
{ "reply": string, "needsClarification"?: string, "proposal"?: { "type": "create_task"|"update_task"|"propose_event"|"create_reminder"|"create_checklist"|"draft_message", "payload": object } }

Proposal payload shapes:
- create_task: { title, description?, priority: "low"|"medium"|"high", dueDate? (ISO), assigneeName? (must be an existing member's name) }
- update_task: { taskId (must be an id from openTasks), title?, description?, status?, priority?, dueDate? }
- propose_event: { title, description?, location?, startAt (ISO), endAt (ISO), category: "appointment"|"family_event"|"personal"|"other" }
- create_reminder: { title, notes?, dueAt (ISO), recurrence: "none"|"daily"|"weekly"|"monthly", remindFamily: boolean }
- create_checklist: { description?, items: [{ title, dueDate?, priority?, assigneeName? }] (max 15) }
- draft_message: { content, toMemberName? } — a message the user will review and explicitly send. Use when the user wants to contact a family member.

AUTHORIZED FAMILY CONTEXT (JSON):
${JSON.stringify(redactContext(ctx), null, 0)}

Current date/time (UTC): ${ctx.currentDateTime}
Family timezone: ${ctx.timezone}
Family name: ${ctx.familyName}`;
}

function redactContext(ctx: FamilyContext): Record<string, unknown> {
  // Keep the context minimal — this is what actually gets sent to the model.
  return {
    members: ctx.members,
    openTasks: ctx.openTasks,
    upcomingEvents: ctx.upcomingEvents,
    pendingReminders: ctx.pendingReminders,
    recentUpdates: ctx.recentUpdates.slice(0, 5),
    notes: ctx.notes,
  };
}

export interface GeminiTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Internal: a model exhausted its (bounded) retryable attempts and the turn
 *  should either switch to the fallback model or terminate honestly. */
class SwitchSignal extends Error {
  constructor(
    public readonly info: { kind: ProviderErrorKind; status?: number; retryAfterMs?: number },
    public readonly lastErr: unknown,
  ) {
    super('model candidates exhausted');
  }
}

/**
 * Sends a conversation turn to Gemini and returns a validated structured reply.
 * Throws honest errors — never fabricates responses on provider failure.
 */
export async function askGemini(
  ctx: FamilyContext,
  history: GeminiTurn[],
  userMessage: string,
): Promise<AiReply> {
  const genai = getClient();
  if (!genai) {
    throw new HttpError(
      503,
      'AI is not configured on this server yet. Set GEMINI_API_KEY to enable the assistant.',
    );
  }

  const contents = [
    ...history.slice(-12).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const startedAt = Date.now();
  const candidates = [...new Set([config.gemini.model, FALLBACK_MODEL])];

  for (let mi = 0; mi < candidates.length; mi++) {
    const model = candidates[mi];
    if (mi > 0 && Date.now() - startedAt > MAX_TOTAL_BUDGET_MS) break;
    if (mi > 0) {
      logger.warn({ from: candidates[mi - 1], to: model, elapsedMs: Date.now() - startedAt }, 'Switching Gemini model after repeated failures');
    }
    try {
      return await runModelTurn(genai, model, contents, ctx, startedAt);
    } catch (err) {
      if (err instanceof SwitchSignal) {
        const canSwitch =
          mi + 1 < candidates.length &&
          Date.now() - startedAt <= MAX_TOTAL_BUDGET_MS;
        if (canSwitch) continue;
        throw terminalAiError(err.info, err.lastErr);
      }
      throw err; // already-final honest HttpError (fatal misconfig, etc.)
    }
  }
  logger.error({ models: candidates }, 'Gemini unavailable within budget');
  throw new HttpError(502, 'The AI service is temporarily unavailable. Please try again in a moment.');
}

async function runModelTurn(
  genai: GoogleGenAI,
  model: string,
  contents: GenerateContentParameters['contents'],
  ctx: FamilyContext,
  startedAt: number,
): Promise<AiReply> {
  const retries = { transient: 0, timeout: 0, malformed: 0, fatal: 0 };

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await withTimeout(
        genai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: buildSystemInstruction(ctx),
            temperature: 0.4,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
          },
        }),
        AI_TIMEOUT_MS,
      );

      const raw = response.text ?? '';
      const parsed = parseProviderJson(raw);
      const validated = aiReplySchema.safeParse(parsed);
      if (!validated.success) {
        logger.warn({ issues: validated.error.issues.length, preview: raw.slice(0, 400) }, 'AI reply failed schema validation');
        throw new ProviderResponseError('schema', new Error('AI reply failed schema validation'));
      }
      logger.debug(summarizeContextForLog(ctx), 'AI turn completed');
      return validated.data;
    } catch (err) {
      const info = classifyProviderError(err);
      retries[info.kind] += 1;
      logger.warn(
        { model, attempt, kind: info.kind, status: info.status ?? null, elapsedMs: Date.now() - startedAt },
        'Gemini request failed',
      );

      // Provider contract flip: only fail fast on errors retrying can never fix.
      const canRetry =
        retries[info.kind] <= MAX_RETRIES[info.kind] &&
        Date.now() - startedAt + AI_TIMEOUT_MS <= MAX_TOTAL_BUDGET_MS;
      if (!canRetry) {
        if (info.kind === 'fatal') throw terminalAiError(info, err);
        throw new SwitchSignal(info, err);
      }

      // Bounded backoff honoring the provider's Retry-After guidance when present.
      const delay = providerBackoffMs(info, retries[info.kind]);
      if (delay > 0) await sleep(delay);
    }
  }
}

/* ---------------------------------------------------------------------------
 * Provider error taxonomy (pure functions — unit-tested). Retry only what a
 * retry can fix: 429/5xx capacity blips, a slow attempt, and malformed model
 * output. Authentication/billing/invalid-request errors fail immediately with
 * an honest message that never leaks provider internals.
 * ------------------------------------------------------------------------- */
export function classifyProviderError(err: unknown): {
  kind: ProviderErrorKind;
  status?: number;
  retryAfterMs?: number;
} {
  // Our own timeout wrapper — a slow attempt is retryable exactly once.
  if (err instanceof Error && /^AI request timed out after \d+ms$/.test(err.message)) {
    return { kind: 'timeout' };
  }
  // parse errors and schema validation failures inside the turn.
  if (err instanceof ProviderResponseError) {
    return { kind: 'malformed' };
  }

  const status =
    (typeof (err as { status?: unknown })?.status === 'number' ? ((err as { status: number }).status) : undefined) ??
    extractStatusFromMessage((err as Error)?.message ?? '');
  const retryAfterMs = extractRetryAfterMs(err);

  if (status && RETRYABLE_STATUS.has(status)) return { kind: 'transient', status, retryAfterMs };
  // "overloaded"/"high demand" bodies sometimes arrive as 500-shaped text.
  if (!status && /overloaded|high demand|temporarily unavailable/i.test((err as Error)?.message ?? '')) {
    return { kind: 'transient', retryAfterMs };
  }
  // Configuration/auth problems sometimes arrive without a numeric status
  // (e.g. "API key not valid") — never retry these; they cannot heal.
  const message = (err as Error)?.message ?? '';
  if (/\bapi[_ -]?key\b|api_key_invalid|permission denied|billing|invalid model/i.test(message)) {
    return { kind: 'fatal', status };
  }
  if (status && status >= 400 && status < 500) {
    return { kind: 'fatal', status };
  }
  return { kind: 'transient', status, retryAfterMs };
}

/** Exponential with cap, honoring Retry-After when the provider supplied one. */
export function providerBackoffMs(
  info: { kind: ProviderErrorKind; retryAfterMs?: number },
  retryCount: number,
): number {
  if (info.kind === 'timeout') return 800; // small settle pause for a slow attempt
  if (info.kind === 'fatal') return 0;
  if (info.retryAfterMs && info.retryAfterMs > 0) return Math.min(info.retryAfterMs, 15_000);
  return Math.min(1000 * 2 ** (retryCount - 1), 8_000);
}

function terminalAiError(
  info: { kind: ProviderErrorKind; status?: number },
  lastErr: unknown,
): never {
  if (info.kind === 'timeout') {
    throw new HttpError(504, 'The model is taking longer than usual right now. Please try again in a moment.');
  }
  if (info.kind === 'fatal') {
    logger.error({ status: info.status ?? null }, 'Gemini configuration or request error (not retried)');
    throw new HttpError(
      500,
      'The AI assistant is misconfigured on this server (check GEMINI_API_KEY and GEMINI_MODEL). Ask the server administrator to fix the configuration.',
    );
  }
  if (info.kind === 'malformed' && lastErr instanceof HttpError) {
    // parseModelJson already produced an accurate, safe user-facing message
    // ("empty response" / "could not interpret safely") — keep it, no retry.
    throw lastErr;
  }
  if (info.kind === 'malformed') {
    throw new HttpError(502, 'The AI returned a reply we could not structure safely. Please try again.');
  }
  logger.error({ status: info.status ?? null }, 'Gemini unavailable after retries');
  throw new HttpError(502, 'The AI service is temporarily unavailable. Please try again in a moment.');
}

/** The SDK sometimes embeds the provider JSON error inside its own message. */
function extractStatusFromMessage(message: string): number | undefined {
  const codeFromJson = /\{"error":\{(?:[^}]*?)"code":(\d{3})/.exec(message)?.[1];
  if (codeFromJson) return Number(codeFromJson);
  const bare = /(?:^|[^0-9])(429|500|502|503|504)(?:[^0-9]|$)/.exec(message)?.[1];
  return bare ? Number(bare) : undefined;
}

function extractRetryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: Record<string, unknown> } | undefined)?.headers;
  const value = headers?.['retry-after'];
  if (typeof value !== 'string') return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Internal wrapper distinguishing parse/validate failure from provider faults. */
class ProviderResponseError extends Error {
  constructor(
    public readonly reason: 'schema' | 'parse',
    cause?: unknown,
  ) {
    super(reason === 'parse' ? 'AI returned a malformed response body' : 'AI reply failed schema validation', { cause });
  }
}

/** parseModelJson kept its behaviour; wrapped so retries classify correctly. */
function parseProviderJson(raw: string): unknown {
  try {
    return parseModelJson(raw);
  } catch (err) {
    if (err instanceof HttpError) throw new ProviderResponseError('parse', err);
    throw err;
  }
}

function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new HttpError(502, 'The AI returned an empty response.');
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some models wrap JSON in code fences; retry peel.
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new HttpError(502, 'The AI returned a response we could not interpret safely.');
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`AI request timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
