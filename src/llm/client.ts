import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'llm' });

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * Thin wrapper over any OpenAI-compatible endpoint — Gemini by default, Groq or
 * OpenRouter by changing three env vars. The engine treats every call as
 * optional: rate limits and outages degrade to the rules engine rather than
 * turning into silence (PLAN §10.5).
 */
class LlmClient {
  private client: OpenAI | null = null;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private lastError: string | null = null;

  private get sdk(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: config.LLM_API_KEY,
        baseURL: config.LLM_BASE_URL,
        timeout: 20_000,
        maxRetries: 0, // we do our own backoff, so 429s degrade fast
      });
    }
    return this.client;
  }

  available(): boolean {
    if (!config.hasLlm) return false;
    if (Date.now() < this.circuitOpenUntil) return false;
    return true;
  }

  status(): { configured: boolean; model: string; circuitOpen: boolean; failures: number; lastError: string | null } {
    return {
      configured: config.hasLlm,
      model: config.LLM_MODEL,
      circuitOpen: Date.now() < this.circuitOpenUntil,
      failures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }

  /**
   * One cheap call at boot to prove the key works. A rejected key otherwise
   * fails quietly on every turn and the bot runs on regexes alone — which
   * looks, from WhatsApp, exactly like a bot that is simply dumb.
   */
  async probe(): Promise<{ ok: boolean; error?: string }> {
    if (!config.hasLlm) return { ok: false, error: 'LLM_API_KEY not set' };
    try {
      await this.sdk.models.list({ timeout: 8_000 });
      this.noteSuccess();
      return { ok: true };
    } catch (err) {
      this.noteFailure(err);
      return { ok: false, error: (err as Error).message };
    }
  }

  private noteSuccess() {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    this.lastError = null;
  }

  private noteFailure(err: unknown) {
    this.consecutiveFailures++;
    this.lastError = (err as Error).message;
    if (this.consecutiveFailures >= 4) {
      // Stop hammering a dead or exhausted endpoint; try again in a minute.
      this.circuitOpenUntil = Date.now() + 60_000;
      log.error({ failures: this.consecutiveFailures }, 'llm circuit opened for 60s');
    }
    log.warn({ err: (err as Error).message, failures: this.consecutiveFailures }, 'llm call failed');
  }

  /** Free-text completion. Throws LlmUnavailableError after its retries. */
  async chat(
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number; deadlineMs?: number } = {},
  ): Promise<string> {
    if (!this.available()) throw new LlmUnavailableError('llm not configured or circuit open');

    // An overall budget across every attempt, not per attempt: three 20s
    // timeouts back to back is a minute of silence on WhatsApp.
    const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
    const attempts = 3;
    for (let i = 0; i < attempts; i++) {
      const remaining = deadline - Date.now();
      if (remaining < 1_000) {
        this.noteFailure(new Error('deadline exceeded'));
        throw new LlmUnavailableError('llm failed: deadline exceeded');
      }
      try {
        const res = await this.sdk.chat.completions.create({
          model: config.LLM_MODEL,
          messages,
          temperature: opts.temperature ?? 0.3,
          // Reasoning models (Gemini 3.x Flash, gpt-oss) count their internal
          // thinking against this budget — a 58-token answer can cost 700.
          // Too low and the JSON comes back truncated.
          max_tokens: opts.maxTokens ?? 1200,
        }, { timeout: Math.min(20_000, remaining) });
        const text = res.choices[0]?.message?.content ?? '';
        this.noteSuccess();
        return text;
      } catch (err) {
        const status = (err as { status?: number }).status;
        const retryable = status === 429 || (status ?? 500) >= 500 || status === undefined;
        const backoff = 400 * 2 ** i + Math.random() * 200;
        if (!retryable || i === attempts - 1 || Date.now() + backoff > deadline - 1_000) {
          this.noteFailure(err);
          throw new LlmUnavailableError(`llm failed: ${(err as Error).message}`);
        }
        await sleep(backoff);
      }
    }
    throw new LlmUnavailableError('unreachable');
  }

  /** Completion constrained to a JSON object. Returns null if it can't be parsed. */
  async chatJson<T = Record<string, unknown>>(
    messages: ChatMessage[],
    opts: { maxTokens?: number; deadlineMs?: number } = {},
  ): Promise<T | null> {
    const raw = await this.chat(
      [...messages, { role: 'system', content: 'Respond with a single JSON object and nothing else.' }],
      { maxTokens: opts.maxTokens ?? 1500, temperature: 0.1, deadlineMs: opts.deadlineMs },
    );
    return parseJsonLoose<T>(raw);
  }
}

/** Models wrap JSON in prose or code fences often enough to handle it here. */
export function parseJsonLoose<T>(raw: string): T | null {
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const llm = new LlmClient();
