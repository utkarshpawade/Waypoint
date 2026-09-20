import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ALLOWED_SENDERS is read from config at import time, so each case re-imports
 * the module with a different environment.
 */
async function loadWith(allowed: string) {
  vi.resetModules();
  process.env.ALLOWED_SENDERS = allowed;
  const { isAllowedSender } = await import('../src/conversation/engine.js');
  return isAllowedSender;
}

beforeEach(() => {
  delete process.env.ALLOWED_SENDERS;
});

describe('allowed senders', () => {
  it('answers everyone when the list is empty — the default', async () => {
    const allowed = await loadWith('');
    expect(allowed('919876543210@s.whatsapp.net')).toBe(true);
    expect(allowed('447700900000@s.whatsapp.net')).toBe(true);
  });

  it('answers only the named numbers when the list is set', async () => {
    const allowed = await loadWith('917838447570,919967877767');
    expect(allowed('917838447570@s.whatsapp.net')).toBe(true);
    expect(allowed('919967877767@s.whatsapp.net')).toBe(true);
    expect(allowed('919999999999@s.whatsapp.net')).toBe(false);
  });

  it('ignores formatting differences between the list and the JID', async () => {
    const allowed = await loadWith('+91 78384 47570, +91-99678-77767');
    expect(allowed('917838447570@s.whatsapp.net')).toBe(true);
    expect(allowed('919967877767@s.whatsapp.net')).toBe(true);
  });

  it('matches a JID that carries a device suffix', async () => {
    // Baileys appends ":12" to a JID on a multi-device send.
    const allowed = await loadWith('917838447570');
    expect(allowed('917838447570:12@s.whatsapp.net')).toBe(true);
  });

  it('matches a number given without its country code', async () => {
    const allowed = await loadWith('7838447570');
    expect(allowed('917838447570@s.whatsapp.net')).toBe(true);
  });

  it('never silences the CLI or in-memory channels, which have no number', async () => {
    const allowed = await loadWith('917838447570');
    expect(allowed('cli-user')).toBe(true);
    expect(allowed('test-user')).toBe(true);
  });

  it('does not read an incidental digit in a non-numeric id as a phone number', async () => {
    // "e2e-user" strips to "2". Treating that as a number silenced the whole
    // end-to-end suite, so the guard now requires something number-shaped.
    const allowed = await loadWith('917838447570');
    expect(allowed('e2e-user')).toBe(true);
    expect(allowed('demo-m3k9x2')).toBe(true);
    expect(allowed('user-1')).toBe(true);
  });

  it('does not let a short suffix match a different number', async () => {
    const allowed = await loadWith('917838447570');
    expect(allowed('919999447570@s.whatsapp.net')).toBe(false);
    expect(allowed('7838447570@s.whatsapp.net')).toBe(true); // same number, no country code
  });
});
