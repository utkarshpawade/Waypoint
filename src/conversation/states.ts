import type { ConversationState } from '../db/types.js';
import type { ToolName } from './tools.js';

/**
 * The finite state machine. Each state declares what the LLM is allowed to
 * propose and where the conversation may legally go next; engine.ts enforces
 * both. A proposal outside this table is dropped, not executed.
 */
export interface StateDef {
  allowedTools: ToolName[];
  requiredSlots: ('origin' | 'destination' | 'departDate')[];
  next: ConversationState[];
}

const EVERYWHERE: ToolName[] = ['escalate_to_human', 'answer_faq'];

export const STATES: Record<ConversationState, StateDef> = {
  GREETING: {
    allowedTools: [...EVERYWHERE, 'search_flights'],
    requiredSlots: [],
    next: ['COLLECTING_TRIP', 'SEARCHING', 'ESCALATED'],
  },
  COLLECTING_TRIP: {
    allowedTools: [...EVERYWHERE, 'search_flights'],
    requiredSlots: ['origin', 'destination', 'departDate'],
    next: ['COLLECTING_TRIP', 'SEARCHING', 'ESCALATED'],
  },
  SEARCHING: {
    allowedTools: [...EVERYWHERE],
    requiredSlots: ['origin', 'destination', 'departDate'],
    next: ['PRESENTING_OPTIONS', 'COLLECTING_TRIP', 'ESCALATED'],
  },
  PRESENTING_OPTIONS: {
    allowedTools: [...EVERYWHERE, 'refine_search', 'select_flight', 'search_flights'],
    requiredSlots: [],
    next: ['AWAITING_SELECTION', 'ESCALATED'],
  },
  AWAITING_SELECTION: {
    allowedTools: [...EVERYWHERE, 'refine_search', 'select_flight', 'search_flights'],
    requiredSlots: [],
    next: ['AWAITING_SELECTION', 'PRESENTING_OPTIONS', 'COLLECTING_PASSENGER', 'SEARCHING', 'ESCALATED'],
  },
  COLLECTING_PASSENGER: {
    allowedTools: [...EVERYWHERE, 'save_passenger', 'select_flight'],
    requiredSlots: [],
    next: ['COLLECTING_PASSENGER', 'CONFIRMING', 'AWAITING_SELECTION', 'ESCALATED'],
  },
  CONFIRMING: {
    allowedTools: [...EVERYWHERE, 'confirm_booking', 'save_passenger'],
    requiredSlots: [],
    next: ['ISSUING', 'COLLECTING_PASSENGER', 'AWAITING_SELECTION', 'ESCALATED'],
  },
  ISSUING: {
    allowedTools: [...EVERYWHERE],
    requiredSlots: [],
    next: ['COMPLETED', 'ESCALATED'],
  },
  COMPLETED: {
    allowedTools: [...EVERYWHERE, 'search_flights'],
    requiredSlots: [],
    next: ['COMPLETED', 'COLLECTING_TRIP', 'SEARCHING', 'ESCALATED'],
  },
  ESCALATED: {
    allowedTools: [],
    requiredSlots: [],
    next: ['HUMAN_CONTROL', 'COLLECTING_TRIP', 'AWAITING_SELECTION', 'COMPLETED'],
  },
  HUMAN_CONTROL: {
    allowedTools: [],
    requiredSlots: [],
    next: ['COLLECTING_TRIP', 'AWAITING_SELECTION', 'COLLECTING_PASSENGER', 'CONFIRMING', 'COMPLETED'],
  },
};

export function isToolAllowed(state: ConversationState, tool: ToolName): boolean {
  return STATES[state].allowedTools.includes(tool);
}

export function canTransition(from: ConversationState, to: ConversationState): boolean {
  if (from === to) return true;
  // Escalation is always legal, from anywhere.
  if (to === 'ESCALATED' || to === 'HUMAN_CONTROL') return true;
  return STATES[from].next.includes(to);
}

export function missingSlots(state: ConversationState, slots: Record<string, unknown>): string[] {
  return STATES[state].requiredSlots.filter((s) => slots[s] === undefined || slots[s] === null);
}
