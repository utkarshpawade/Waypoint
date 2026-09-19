import { z } from 'zod';
import { getAirport } from '../flights/airports.js';

/**
 * Every tool the model may propose, and the zod schema its arguments must pass
 * before the engine will execute it. A schema failure is returned to the model
 * as a tool error it may recover from once; a second failure escalates.
 */

export const TOOL_NAMES = [
  'search_flights',
  'refine_search',
  'select_flight',
  'save_passenger',
  'confirm_booking',
  'answer_faq',
  'escalate_to_human',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(x: unknown): x is ToolName {
  return typeof x === 'string' && (TOOL_NAMES as readonly string[]).includes(x);
}

const iata = z
  .string()
  .trim()
  .toUpperCase()
  .length(3)
  .refine((v) => Boolean(getAirport(v)), { message: 'unknown airport code' });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected yyyy-mm-dd');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

export const searchFlightsArgs = z.object({
  origin: iata.optional(),
  destination: iata.optional(),
  departDate: isoDate.optional(),
  returnDate: isoDate.optional(),
});

export const refineSearchArgs = z.object({
  nonStopOnly: z.boolean().optional(),
  maxPrice: z.number().positive().max(10_000_000).optional(),
  preference: z.enum(['CHEAPEST', 'FASTEST', 'BEST_VALUE', 'COMFORT']).optional(),
  departWindow: z.object({ earliest: hhmm.optional(), latest: hhmm.optional() }).optional(),
  carrier: z.string().trim().min(2).max(3).optional(),
});

export const selectFlightArgs = z.object({
  index: z.coerce.number().int().min(1).max(3),
});

export const answerFaqArgs = z.object({
  query: z.string().trim().min(2).max(300),
});

export const escalateArgs = z.object({
  reason: z
    .enum([
      'USER_REQUESTED_HUMAN',
      'LOW_CONFIDENCE_REPEATED',
      'OUT_OF_SCOPE',
      'KNOWLEDGE_GAP',
      'PROVIDER_FAILURE',
      'POLICY_SENSITIVE',
      'NEGATIVE_SENTIMENT',
      'HIGH_VALUE',
    ])
    .catch('KNOWLEDGE_GAP'),
  note: z.string().max(400).optional(),
});

export const passengerSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(3, 'that looks too short for a full name')
    .max(70)
    .regex(/^[A-Za-z][A-Za-z .'-]+ [A-Za-z][A-Za-z .'-]*$/, 'please give the full name as printed on the ID'),
  dateOfBirth: isoDate,
  gender: z.enum(['M', 'F', 'X']),
  email: z.string().trim().email('that email does not look right').max(120),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[^\d+]/g, ''))
    .refine((v) => v.replace(/\D/g, '').length >= 10, 'that phone number looks incomplete'),
  passportNo: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-PR-WY][0-9]{7}$/, 'an Indian passport number looks like A1234567')
    .optional(),
  passportExpiry: isoDate.optional(),
  nationality: z.string().trim().min(2).max(40).optional(),
});

export type ValidatedPassenger = z.infer<typeof passengerSchema>;

export const TOOL_SCHEMAS = {
  search_flights: searchFlightsArgs,
  refine_search: refineSearchArgs,
  select_flight: selectFlightArgs,
  save_passenger: z.object({}).passthrough(),
  confirm_booking: z.object({}).passthrough(),
  answer_faq: answerFaqArgs,
  escalate_to_human: escalateArgs,
} satisfies Record<ToolName, z.ZodTypeAny>;

export type ToolValidation =
  | { ok: true; args: unknown }
  | { ok: false; error: string };

/**
 * Models routinely emit `"maxPrice": null` for optional fields they are not
 * setting, which zod's `.optional()` rejects. An explicit null means "no
 * value", so drop those keys before validating rather than failing the tool.
 */
function dropNulls(args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === null) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? dropNulls(v) : v;
  }
  return out;
}

export function validateToolArgs(tool: ToolName, args: unknown): ToolValidation {
  const schema = TOOL_SCHEMAS[tool];
  const parsed = schema.safeParse(dropNulls(args) ?? {});
  if (parsed.success) return { ok: true, args: parsed.data };
  return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

/**
 * Human-readable validation of a passenger draft: which fields are still
 * missing, and which are present but wrong. Drives the collection prompts.
 */
export function validatePassengerDraft(
  draft: Record<string, unknown>,
  opts: { international: boolean; departDate?: string },
): { valid: boolean; missing: string[]; errors: Record<string, string>; value?: ValidatedPassenger } {
  const required = ['fullName', 'dateOfBirth', 'gender', 'email', 'phone'];
  if (opts.international) required.push('passportNo', 'passportExpiry', 'nationality');

  const missing = required.filter((f) => !draft[f]);
  const errors: Record<string, string> = {};

  const schema = opts.international
    ? passengerSchema.required({ passportNo: true, passportExpiry: true, nationality: true })
    : passengerSchema;

  const present = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(present);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? '');
      // Only report a problem for a field the user actually supplied.
      if (field && present[field] !== undefined) errors[field] = issue.message;
    }
  }

  // Age sanity: a date of birth must be in the past, under 120 years, and
  // before the travel date.
  if (typeof draft.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(draft.dateOfBirth)) {
    const dob = new Date(draft.dateOfBirth);
    const now = new Date();
    const years = (now.getTime() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (years < 0) errors.dateOfBirth = 'that date of birth is in the future';
    else if (years > 120) errors.dateOfBirth = 'that date of birth is more than 120 years ago';
    else if (opts.departDate && draft.dateOfBirth > opts.departDate) {
      errors.dateOfBirth = 'that date of birth is after the travel date';
    }
  }

  // Passport must outlast the trip — 6 months is the usual entry rule.
  if (typeof draft.passportExpiry === 'string' && opts.departDate && draft.passportExpiry < opts.departDate) {
    errors.passportExpiry = 'that passport expires before the travel date';
  }

  const valid = missing.length === 0 && Object.keys(errors).length === 0 && parsed.success;
  return { valid, missing, errors, value: valid ? (parsed.data as ValidatedPassenger) : undefined };
}

export const FIELD_PROMPTS: Record<string, string> = {
  fullName: 'full name exactly as printed on the ID',
  dateOfBirth: 'date of birth (dd/mm/yyyy)',
  gender: 'gender (M/F)',
  email: 'email for the itinerary',
  phone: 'contact number',
  passportNo: 'passport number',
  passportExpiry: 'passport expiry date',
  nationality: 'nationality',
};
