import type { CabinClass, FlightOffer, Preference, TripType } from '../flights/types.js';

export type ConversationState =
  | 'GREETING'
  | 'COLLECTING_TRIP'
  | 'SEARCHING'
  | 'PRESENTING_OPTIONS'
  | 'AWAITING_SELECTION'
  | 'COLLECTING_PASSENGER'
  | 'CONFIRMING'
  | 'ISSUING'
  | 'COMPLETED'
  | 'ESCALATED'
  | 'HUMAN_CONTROL';

export type Control = 'BOT' | 'HUMAN';

export interface TripSlots {
  origin?: string;
  destination?: string;
  departDate?: string;
  returnDate?: string;
  tripType?: TripType;
  adults?: number;
  children?: number;
  infants?: number;
  cabin?: CabinClass;
  preference?: Preference;
  budgetMax?: number;
  nonStopOnly?: boolean;
  departWindow?: { earliest?: string; latest?: string };
}

export interface PassengerDraft {
  fullName?: string;
  dateOfBirth?: string;
  gender?: 'M' | 'F' | 'X';
  email?: string;
  phone?: string;
  passportNo?: string;
  passportExpiry?: string;
  nationality?: string;
}

export interface SessionSlots {
  trip: TripSlots;
  /** Completed passengers, in order. */
  passengers: PassengerDraft[];
  /** Passenger currently being collected. */
  draftPassenger: PassengerDraft;
  lowConfidenceStreak: number;
  corrections: number;
  clarifyCount: Record<string, number>;
  lastIntent?: string;
  bookingRef?: string;
  escalationTicket?: string;
  greeted?: boolean;
  /** Set once the disambiguation question for a city has been asked. */
  pendingDisambiguation?: { slot: 'origin' | 'destination'; options: string[] };
}

export interface SessionRecord {
  id: string;
  channel: string;
  channelUserId: string;
  displayName: string | null;
  state: ConversationState;
  slots: SessionSlots;
  offers: FlightOffer[] | null;
  selectedOfferId: string | null;
  control: Control;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id?: number;
  sessionId: string;
  waMsgId?: string | null;
  direction: 'IN' | 'OUT';
  author: 'USER' | 'BOT' | 'AGENT';
  body: string;
  confidence?: number | null;
  intent?: string | null;
  createdAt?: Date;
}

export type BookingStatus = 'QUOTED' | 'AWAITING_PAYMENT' | 'PAID' | 'CANCELLED';

export interface BookingRecord {
  ref: string;
  sessionId: string;
  offer: FlightOffer;
  total: number;
  currency: string;
  status: BookingStatus;
  paymentLink: string | null;
  emailTo: string | null;
  emailedAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface PassengerRecord {
  id?: number;
  bookingRef: string;
  seq: number;
  fullName: string;
  dob: string;
  gender: string;
  email: string | null;
  phone: string | null;
  passportNo: string | null;
  passportExpiry: string | null;
  nationality: string | null;
}

export type EscalationStatus = 'OPEN' | 'CLAIMED' | 'RESOLVED';

export type EscalationReason =
  | 'USER_REQUESTED_HUMAN'
  | 'LOW_CONFIDENCE_REPEATED'
  | 'OUT_OF_SCOPE'
  | 'KNOWLEDGE_GAP'
  | 'PROVIDER_FAILURE'
  | 'POLICY_SENSITIVE'
  | 'NEGATIVE_SENTIMENT'
  | 'HIGH_VALUE';

export interface HandoffBrief {
  situation: string;
  entities: Record<string, unknown>;
  transcript: { author: string; body: string }[];
  botTried: string[];
  blocker: string;
  confidenceTrace: number[];
  suggestedReply: string;
}

export interface EscalationRecord {
  ticket: string;
  sessionId: string;
  reason: EscalationReason;
  confidence: number | null;
  brief: HandoffBrief;
  status: EscalationStatus;
  claimedBy: string | null;
  resolution: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  resolvedAt: Date | null;
  /** Set when the SLA reminder has already been sent, so it fires once. */
  slaNotifiedAt?: Date | null;
}

export interface EventRecord {
  id?: number;
  sessionId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt?: Date;
}

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;
  readonly kind: 'postgres' | 'memory';

  getSessionByChannelUser(channel: string, channelUserId: string): Promise<SessionRecord | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  createSession(s: Omit<SessionRecord, 'createdAt' | 'updatedAt'>): Promise<SessionRecord>;
  saveSession(s: SessionRecord): Promise<void>;

  /** Returns false when the wa_msg_id was already recorded (replayed message). */
  insertMessage(m: MessageRecord): Promise<boolean>;
  recentMessages(sessionId: string, limit: number): Promise<MessageRecord[]>;

  createBooking(b: Omit<BookingRecord, 'createdAt'>): Promise<BookingRecord>;
  getBooking(ref: string): Promise<BookingRecord | null>;
  updateBooking(ref: string, patch: Partial<BookingRecord>): Promise<void>;

  insertPassengers(rows: PassengerRecord[]): Promise<void>;
  listPassengers(bookingRef: string): Promise<PassengerRecord[]>;

  createEscalation(e: Omit<EscalationRecord, 'createdAt' | 'claimedAt' | 'resolvedAt'>): Promise<EscalationRecord>;
  getEscalation(ticket: string): Promise<EscalationRecord | null>;
  listEscalations(status?: EscalationStatus): Promise<EscalationRecord[]>;
  updateEscalation(ticket: string, patch: Partial<EscalationRecord>): Promise<void>;
  findOpenEscalationBySession(sessionId: string): Promise<EscalationRecord | null>;

  insertEvent(e: EventRecord): Promise<void>;
  countEvents(type: string): Promise<number>;
  rawQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
