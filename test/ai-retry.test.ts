/**
 * Regression tests for the AI provider retry/timeout fix (Part A).
 *
 * Root cause verified on 2026-10-23: `gemini-3.8-flash` is a VALID model
 * (confirmed via ListModels), but provider latency is currently 55–95 s per
 * turn, so the old 30 s per-attempt timeout expired every attempt and the
 * honest "temporarily unavailable" error fired even though Gemini was about
 * to answer. New policy: 120 s per attempt, class-based retry ceilings
 * (429/5xx transient → 2, timeout → 1, malformed → 2, fatal → 0), bounded
 * total budget, and accurate user-facing terminal messages.
 *
 * The @google/genai SDK is mocked with a per-test CONSUMED queue (shift()),
 * so scripts can never be misindexed; each test re-imports the module for
 * a fresh cached client. These tests never touch the network.
 */
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'ai-retry-test-secret-0123456789abcdef';
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/unused-ai-retry';
// AI must look configured for askGemini to run; the SDK is mocked anyway.
process.env.GEMINI_API_KEY = 'test-key-not-a-secret';
process.env.GEMINI_MODEL = 'test-model-name';
vi.useFakeTimers();

/** Each entry is a thunk the mocked generateContent consumes exactly once. */
const state = vi.hoisted(() => ({
  queue: [] as Array<() => unknown>,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => {
        const fn = state.queue.shift();
        if (!fn) throw Object.assign(new Error('mock queue exhausted'), { status: 418 });
        return await fn();
      },
    };
  },
}));

type Step = { fail: Error } | { ok: string };

function script(...steps: Step[]) {
  state.queue = steps.map((s) => ('fail' in s ? () => { throw s.fail; } : () => ({ text: s.ok })));
}

let askGemini: typeof import('../src/services/ai/gemini').askGemini;
let classifyProviderError: typeof import('../src/services/ai/gemini').classifyProviderError;
let providerBackoffMs: typeof import('../src/services/ai/gemini').providerBackoffMs;

const ctx = {
  familyName: 'AI Retry Test Family',
  members: [{ id: 'a'.repeat(24), name: 'Test Member', role: 'owner' }],
  openTasks: [],
  upcomingEvents: [],
  pendingReminders: [],
  recentUpdates: [],
  notes: [],
  currentDateTime: '2026-10-23T05:00:00.000Z',
  timezone: 'UTC',
} as unknown as import('../src/services/ai/context').FamilyContext;

const timeoutErr = new Error('AI request timed out after 120000ms');
const provider503 = Object.assign(
  new Error('{\n  "error": {\n    "code": 503, "message": "This model is currently experiencing high demand.", "status": "UNAVAILABLE"\n  }\n}\n'),
  { status: 503 },
);
const provider429 = Object.assign(
  new Error('{\n  "error": {\n    "code": 429, "message": "Resource exhausted.", "status": "RESOURCE_EXHAUSTED"\n  }\n}\n'),
  { status: 429 },
);
const provider401 = Object.assign(new Error('API key not valid'), { status: 401 });
const VALID = JSON.stringify({ reply: 'structured ok' });
const MALFORMED = 'planet X looms tomorrow';

beforeAll(async () => {
  const mod = await import('../src/services/ai/gemini');
  askGemini = mod.askGemini;
  classifyProviderError = mod.classifyProviderError;
  providerBackoffMs = mod.providerBackoffMs;
});

afterAll(() => {
  vi.useRealTimers();
  state.queue = [];
});

describe('pure helpers: classifyProviderError', () => {
  it('marks 429/5xx statuses transient and keeps Retry-After', () => {
    expect(classifyProviderError(provider503)).toMatchObject({ kind: 'transient', status: 503 });
    expect(classifyProviderError({ status: 503, message: '...', headers: { 'retry-after': '7' } })).toMatchObject({
      kind: 'transient',
      retryAfterMs: 7000,
    });
  });
  it('marks our timeout wrapper as timeout', () => {
    expect(classifyProviderError(timeoutErr)).toMatchObject({ kind: 'timeout' });
  });
  it('marks 4xx as fatal (invalid key/model, billing) — never retried', () => {
    expect(classifyProviderError(provider401)).toMatchObject({ kind: 'fatal', status: 401 });
    expect(classifyProviderError(new Error('API key not valid'))).toMatchObject({ kind: 'fatal' });
  });
  it('treats "overloaded"/high-demand texts without status as transient', () => {
    expect(classifyProviderError(new Error('model is overloaded today'))).toMatchObject({ kind: 'transient' });
  });
});

describe('pure helpers: providerBackoffMs', () => {
  it('honors provider Retry-After guidance (capped at 15s)', () => {
    expect(providerBackoffMs({ kind: 'transient', retryAfterMs: 7000 }, 1)).toBe(7000);
    expect(providerBackoffMs({ kind: 'transient', retryAfterMs: 60000 }, 1)).toBeLessThanOrEqual(15000);
  });
  it('grows exponentially for transient retries, bounded', () => {
    expect(providerBackoffMs({ kind: 'transient' }, 1)).toBe(1000);
    expect(providerBackoffMs({ kind: 'transient' }, 2)).toBe(2000);
    expect(providerBackoffMs({ kind: 'transient' }, 5)).toBeLessThanOrEqual(8000);
  });
  it('no backoff for fatal errors', () => {
    expect(providerBackoffMs({ kind: 'fatal' }, 1)).toBe(0);
  });
});

describe('askGemini retry policy (mocked SDK)', () => {
  it('a transient 503 then success returns the validated reply — no fabricated fallback', async () => {
    script({ fail: provider503 }, { ok: VALID });
    const p = askGemini(ctx, [{ role: 'user', content: 'hi' }], 'hello');
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.reply).toBe('structured ok');
    expect(state.queue).toHaveLength(0);
  });

  it('double 503 + success uses all three attempts', async () => {
    script({ fail: provider503 }, { fail: provider503 }, { ok: VALID });
    const p = askGemini(ctx, [], 'hello');
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.reply).toBe('structured ok');
    expect(state.queue).toHaveLength(0);
  });

  it('exhausted transient retries on both models throw the honest 502 "temporarily unavailable" message', async () => {
    // model0: 503, 429, 503 (exhausted) → switch → model1: 503, 503, 503 (exhausted) → terminal
    script(
      { fail: provider503 }, { fail: provider429 }, { fail: provider503 },
      { fail: provider503 }, { fail: provider503 }, { fail: provider503 },
    );
    const p = askGemini(ctx, [], 'hello');
    const outcome = p.catch((e: unknown) => e); // attach synchronously — no unhandled window
    await vi.runAllTimersAsync();
    const err = (await outcome) as Error;
    expect(err.message).toBe('The AI service is temporarily unavailable. Please try again in a moment.');
    expect(state.queue).toHaveLength(0);
  });

  it('falls back to the second model when the primary keeps timing out', async () => {
    // model0: timeout, timeout (exhausted) → switch → model1 answers immediately
    script({ fail: timeoutErr }, { fail: timeoutErr }, { ok: VALID });
    const p = askGemini(ctx, [], 'hello');
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.reply).toBe('structured ok');
    expect(state.queue).toHaveLength(0);
  });

  it('both models timing out throws an accurate 504 "taking longer" message', async () => {
    script({ fail: timeoutErr }, { fail: timeoutErr }, { fail: timeoutErr }, { fail: timeoutErr });
    const p = askGemini(ctx, [], 'hello');
    const outcome = p.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await outcome) as Error;
    expect(err.message).toBe('The model is taking longer than usual right now. Please try again in a moment.');
    expect(state.queue).toHaveLength(0);
  });

  it('fatal 4xx (invalid key/config) fails immediately after exactly one attempt', async () => {
    script({ fail: provider401 });
    const p = askGemini(ctx, [], 'hello');
    const outcome = p.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await outcome) as Error;
    expect(err.message).toContain('misconfigured');
    expect(state.queue).toHaveLength(0);
  });

  it('malformed model output is retried per model, then reports honestly — never a fake reply', async () => {
    // model0: 3 malformed (exhausted) → switch → model1: 3 more (exhausted) → terminal
    script(
      { ok: MALFORMED }, { ok: MALFORMED }, { ok: MALFORMED },
      { ok: MALFORMED }, { ok: MALFORMED }, { ok: MALFORMED },
    );
    const p = askGemini(ctx, [], 'hello');
    const outcome = p.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await outcome) as Error;
    expect(err.message).toBe('The AI returned a reply we could not structure safely. Please try again.');
    expect(state.queue).toHaveLength(0);
  });

  it('an OK-but-invalid-schema string cannot pass as a reply', async () => {
    script({ ok: 'sure, whatever you like' }, { ok: VALID });
    const p = askGemini(ctx, [], 'hello');
    await vi.runAllTimersAsync();
    expect((await p).reply).toBe('structured ok');
    expect(state.queue).toHaveLength(0);
  });
});
