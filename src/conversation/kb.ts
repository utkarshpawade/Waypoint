import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface KbEntry {
  id: string;
  topic: string;
  keywords: string[];
  question: string;
  answer: string;
  source: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const KB: KbEntry[] = JSON.parse(readFileSync(join(here, '..', '..', 'data', 'kb.json'), 'utf8'));

/**
 * Curated answers only. A miss returns null and the caller escalates — the bot
 * never improvises an answer to an adjacent question. Entries whose `source`
 * starts with "Escalate:" are deliberate hand-offs: we have a holding line for
 * the user, but a human owns the actual answer.
 */
export function lookupKb(text: string): { entry: KbEntry; score: number } | null {
  const lower = text.toLowerCase();
  let best: { entry: KbEntry; score: number } | null = null;

  for (const entry of KB) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (lower.includes(kw.toLowerCase())) score += kw.includes(' ') ? 2 : 1;
    }
    if (score > (best?.score ?? 0)) best = { entry, score };
  }
  return best && best.score >= 1 ? best : null;
}

export function isHandoffEntry(entry: KbEntry): boolean {
  return entry.source.startsWith('Escalate:');
}
