import { describe, expect, it } from 'vitest';
import { validatePassengerDraft, validateToolArgs } from '../src/conversation/tools.js';

const GOOD = {
  fullName: 'Rahul Sharma',
  dateOfBirth: '1992-04-12',
  gender: 'M',
  email: 'rahul@example.com',
  phone: '9876543210',
};

const DOMESTIC = { international: false, departDate: '2026-12-15' };
const INTERNATIONAL = { international: true, departDate: '2026-12-15' };

describe('passenger validation', () => {
  it('accepts a complete domestic passenger', () => {
    const r = validatePassengerDraft(GOOD, DOMESTIC);
    expect(r.valid).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.value?.fullName).toBe('Rahul Sharma');
  });

  it('lists what is still missing without complaining about it', () => {
    const r = validatePassengerDraft({ fullName: 'Rahul Sharma' }, DOMESTIC);
    expect(r.valid).toBe(false);
    expect(r.missing).toEqual(['dateOfBirth', 'gender', 'email', 'phone']);
    expect(r.errors).toEqual({});
  });

  it('requires passport fields only on international routes', () => {
    expect(validatePassengerDraft(GOOD, DOMESTIC).valid).toBe(true);
    const intl = validatePassengerDraft(GOOD, INTERNATIONAL);
    expect(intl.valid).toBe(false);
    expect(intl.missing).toEqual(['passportNo', 'passportExpiry', 'nationality']);
  });

  it('accepts a complete international passenger', () => {
    const r = validatePassengerDraft(
      { ...GOOD, passportNo: 'M1234567', passportExpiry: '2031-08-20', nationality: 'Indian' },
      INTERNATIONAL,
    );
    expect(r.valid).toBe(true);
  });

  it('rejects a single-word name — it must match the ID', () => {
    const r = validatePassengerDraft({ ...GOOD, fullName: 'Rahul' }, DOMESTIC);
    expect(r.valid).toBe(false);
    expect(r.errors.fullName).toMatch(/full name/i);
  });

  it('rejects a malformed email and phone', () => {
    expect(validatePassengerDraft({ ...GOOD, email: 'rahul@' }, DOMESTIC).errors.email).toMatch(/email/i);
    expect(validatePassengerDraft({ ...GOOD, phone: '12345' }, DOMESTIC).errors.phone).toMatch(/incomplete/i);
  });

  it('strips formatting from a phone number rather than rejecting it', () => {
    const r = validatePassengerDraft({ ...GOOD, phone: '+91 98765-43210' }, DOMESTIC);
    expect(r.valid).toBe(true);
    expect(r.value?.phone).toBe('+919876543210');
  });

  it('rejects a date of birth in the future or absurdly far in the past', () => {
    expect(validatePassengerDraft({ ...GOOD, dateOfBirth: '2099-01-01' }, DOMESTIC).errors.dateOfBirth).toMatch(
      /future/,
    );
    expect(validatePassengerDraft({ ...GOOD, dateOfBirth: '1880-01-01' }, DOMESTIC).errors.dateOfBirth).toMatch(
      /120 years/,
    );
  });

  it('rejects a date of birth after the travel date', () => {
    const r = validatePassengerDraft({ ...GOOD, dateOfBirth: '2027-01-01' }, DOMESTIC);
    expect(r.errors.dateOfBirth).toBeDefined();
  });

  it('rejects a passport that expires before the trip', () => {
    const r = validatePassengerDraft(
      { ...GOOD, passportNo: 'M1234567', passportExpiry: '2026-01-01', nationality: 'Indian' },
      INTERNATIONAL,
    );
    expect(r.errors.passportExpiry).toMatch(/expires before/);
  });

  it('rejects a passport number that is not the right shape', () => {
    const r = validatePassengerDraft(
      { ...GOOD, passportNo: '12345', passportExpiry: '2031-08-20', nationality: 'Indian' },
      INTERNATIONAL,
    );
    expect(r.errors.passportNo).toMatch(/A1234567/);
  });
});

describe('date handling', () => {
  it('keeps a date of birth as a plain date, with no timezone shift', () => {
    // A DOB is a calendar date, not an instant. Turning it into a Date and
    // back through toISOString() shifts it a day behind in any timezone east
    // of UTC — and a DOB that no longer matches the passport fails at the gate.
    const r = validatePassengerDraft({ ...GOOD, dateOfBirth: '1992-04-12' }, DOMESTIC);
    expect(r.valid).toBe(true);
    expect(r.value?.dateOfBirth).toBe('1992-04-12');
    expect(new Date(r.value!.dateOfBirth).toISOString().slice(0, 10)).toBe('1992-04-12');
  });

  it('keeps a passport expiry exact too', () => {
    const r = validatePassengerDraft(
      { ...GOOD, passportNo: 'M1234567', passportExpiry: '2031-08-20', nationality: 'Indian' },
      INTERNATIONAL,
    );
    expect(r.value?.passportExpiry).toBe('2031-08-20');
  });
});

describe('tool argument validation', () => {
  it('accepts valid search arguments and uppercases codes', () => {
    const r = validateToolArgs('search_flights', { origin: 'blr', destination: 'dxb', departDate: '2026-12-15' });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.args as { origin: string }).origin).toBe('BLR');
  });

  it('rejects an airport code the data set does not contain', () => {
    const r = validateToolArgs('search_flights', { origin: 'ZZZ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown airport/);
  });

  it('rejects a malformed date', () => {
    const r = validateToolArgs('search_flights', { departDate: '15 Dec' });
    expect(r.ok).toBe(false);
  });

  it('bounds the selection index to the three options actually shown', () => {
    expect(validateToolArgs('select_flight', { index: 2 }).ok).toBe(true);
    expect(validateToolArgs('select_flight', { index: 7 }).ok).toBe(false);
    expect(validateToolArgs('select_flight', { index: 0 }).ok).toBe(false);
  });

  it('rejects a refinement with a nonsense departure window', () => {
    expect(validateToolArgs('refine_search', { departWindow: { earliest: '25:00' } }).ok).toBe(false);
    expect(validateToolArgs('refine_search', { departWindow: { earliest: '06:00', latest: '12:00' } }).ok).toBe(true);
  });

  it('falls back to a safe reason rather than failing an escalation', () => {
    const r = validateToolArgs('escalate_to_human', { reason: 'SOMETHING_MADE_UP' });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.args as { reason: string }).reason).toBe('KNOWLEDGE_GAP');
  });
});
