import { GoogleGenAI } from '@google/genai';
import { config } from '../../config/env';
import { HttpError } from '../../middleware/familyAccess';
import { logger } from '../../config/logger';
import { AiReply, aiReplySchema } from './schemas';
import { FamilyContext, summarizeContextForLog } from './context';

const AI_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

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

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await withTimeout(
        genai.models.generateContent({
          model: config.gemini.model,
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
      const parsed = parseModelJson(raw);
      const validated = aiReplySchema.safeParse(parsed);
      if (!validated.success) {
        logger.warn({ issues: validated.error.issues.length, preview: raw.slice(0, 400) }, 'AI reply failed schema validation');
        // Retry once handled by loop; if final attempt, surface honest error.
        lastError = validated.error;
        continue;
      }
      logger.debug(summarizeContextForLog(ctx), 'AI turn completed');
      return validated.data;
    } catch (err) {
      lastError = err;
      logger.warn({ attempt, error: (err as Error)?.message }, 'Gemini request failed');
      if (attempt < MAX_RETRIES) {
        await sleep(400 * (attempt + 1));
      }
    }
  }

  if (lastError instanceof HttpError) throw lastError;
  logger.error({ err: lastError }, 'Gemini unavailable after retries');
  throw new HttpError(
    502,
    'The AI service is temporarily unavailable. Please try again in a moment.',
  );
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
