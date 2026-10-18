import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonical, fingerprint, isToolName, sanitize, scopeSchema, toolSchemas } from '../src/validation.js';

describe('tool boundary validation', () => {
  it.each(['user_id', 'actor_id', 'role', 'facility_id', 'tenant_id', 'run_id'])('rejects actor-supplied identity field %s', key => {
    expect(toolSchemas.get_asset.safeParse({ asset_id: 'P-204', [key]: 'other' }).success).toBe(false);
  });
  it.each([0, -1, 0.5, '1', 10001, null])('rejects invalid reservation quantity %s', quantity => {
    expect(toolSchemas.reserve_part.safeParse({ asset_id: 'P-204', part_id: 'BRG-204', quantity }).success).toBe(false);
  });
  it('rejects duplicate evidence, unknown priority, and unrecognized tools', () => {
    expect(toolSchemas.create_work_order.safeParse({ asset_id: 'P-204', title: 'Check bearing', priority: 'urgent', evidence_ids: ['M-7', 'M-7'] }).success).toBe(false);
    expect(toolSchemas.create_work_order.safeParse({ asset_id: 'P-204', title: 'Check bearing', priority: 'emergency', evidence_ids: ['M-7'] }).success).toBe(false);
    expect(isToolName('__proto__')).toBe(false);
    expect(isToolName('constructor')).toBe(false);
    expect(isToolName('get_asset')).toBe(true);
  });
  it('preserves nested semantic equality in content fingerprints', () => {
    expect(fingerprint({ b: { x: 1, y: 2 }, a: [1, 2] })).toBe(fingerprint({ a: [1, 2], b: { y: 2, x: 1 } }));
    expect(fingerprint({ a: [1, 2] })).not.toBe(fingerprint({ a: [2, 1] }));
    expect(canonical({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
  it('recursively redacts credentials and contact information in audit records', () => {
    const sanitized = sanitize({ asset_id: 'P-204', token: 'opaque', nested: [{ employee_contact: 'private', notes: 'reach jo@example.test or 555-010-1234' }], user_id: 'impersonation' });
    expect(sanitized).toEqual({ asset_id: 'P-204', token: '[REDACTED]', nested: [{ employee_contact: '[REDACTED]', notes: 'reach [REDACTED_EMAIL] or [REDACTED_PHONE]' }], user_id: '[REDACTED]' });
  });
  it('preserves PostgreSQL Date evidence through nested redaction', () => {
    expect(sanitize({ readings: [{ observed_at: new Date('2026-10-17T11:45:00Z') }], effective_at: new Date('2026-09-01T00:00:00Z') })).toEqual({ readings: [{ observed_at: '2026-10-17T11:45:00.000Z' }], effective_at: '2026-09-01T00:00:00.000Z' });
  });
  it('redacts camelCase secrets, home addresses and credential strings', () => {
    expect(sanitize({ phoneNumber: '555-010-1234', apiKey: 'secret', homeAddress: 'private residence', personal_address: 'private residence', notes: 'use Bearer abcDEF0123_- please' })).toEqual({ phoneNumber: '[REDACTED]', apiKey: '[REDACTED]', homeAddress: '[REDACTED]', personal_address: '[REDACTED]', notes: 'use [REDACTED_CREDENTIAL] please' });
  });
  it('redacts private text in dynamic keys while preserving technical field names', () => {
    const result = sanitize({
      asset_id: 'P-204', evidence_ids: ['TEL-1', 'M-7'], manual_revision_id: 'M-7',
      nested: { 'private.person@example.invalid': 'ordinary', 'Bearer fixture-private-token': 'ordinary', '555-010-1234': 'ordinary' },
    });
    expect(result).toEqual({
      asset_id: 'P-204', evidence_ids: ['TEL-1', 'M-7'], manual_revision_id: 'M-7',
      nested: { '[REDACTED_EMAIL]': '[REDACTED]', '[REDACTED_CREDENTIAL]': '[REDACTED]', '[REDACTED_PHONE]': '[REDACTED]' },
    });
  });
  it('redacts configured credential keys across acronym and camelCase spellings', () => {
    expect(sanitize({ APIKey: 'private', apiKey: 'private', API_KEY: 'private', APIKEY: 'private', clientAPIKey: 'private',
      HOMEAddress: 'private', asset_id: 'P-204', telemetry_id: 'TEL-1', manual_revision_id: 'M-7', PLCStatus: 'ready' })).toEqual({
      APIKey: '[REDACTED]', apiKey: '[REDACTED]', API_KEY: '[REDACTED]', APIKEY: '[REDACTED]', clientAPIKey: '[REDACTED]',
      HOMEAddress: '[REDACTED]', asset_id: 'P-204', telemetry_id: 'TEL-1', manual_revision_id: 'M-7', PLCStatus: 'ready',
    });
  });
  it('redacts complete email local parts with the configured punctuation and surrounding text', () => {
    expect(sanitize('Contact (a.b_c%tag+part-name@sub.example.invalid), then +other@example.invalid.')).toBe(
      'Contact ([REDACTED_EMAIL]), then [REDACTED_EMAIL].');
    expect(sanitize('prefix-name@example.invalid suffix')).toBe('[REDACTED_EMAIL] suffix');
  });
  it('bounds privacy scans for accepted procedures and keys within the request-size limit', async () => {
    const script = `
      import { sanitize, scopeSchema } from ${JSON.stringify(new URL('../src/validation.ts', import.meta.url).href)};
      const procedure = 'x'.repeat(30000);
      scopeSchema.parse({ run_id: 'fa17dadc-4531-44d1-b3f9-730cff18090d', scenario: {
        clock: '2026-10-17T12:00:00Z', actor: { id: 'tech', role: 'technician', facility_id: 'F1', tenant_id: 'T1' },
        seed: { assets: [{ id: 'P-204', name: 'Pump', facility_id: 'F1', tenant_id: 'T1', status: 'running' }],
          manuals: [{ id: 'M7', asset_id: 'P-204', revision: 'R7', approved: true,
          effective_at: '2026-10-01T00:00:00Z', temperature_limit_c: 85, vibration_limit_mm_s: 5, procedure }] }
      } });
      if (sanitize(procedure, 0, false) !== procedure) throw new Error('Procedure changed');
      for (const letter of ['x', 'X']) {
        const key = letter.repeat(1572864);
        const input = { asset_id: 'P-204', [key]: 'ordinary' };
        if (Buffer.byteLength(JSON.stringify(input)) >= 2 * 1024 * 1024) throw new Error('Input exceeds body bound');
        if (sanitize(input)[key] !== 'ordinary') throw new Error('Technical key changed');
      }
      console.log('completed');
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      timeout: 5000, maxBuffer: 1024,
    });
    expect(stdout.trim()).toBe('completed');
  }, 10000);
  it('keeps valid Unicode while making invalid audit keys and values safe for PostgreSQL', () => {
    const title = 'Inspect bearing at 85°C 🔧';
    expect(toolSchemas.create_work_order.safeParse({ asset_id: 'P-204', title, priority: 'normal', evidence_ids: ['TEL-1'] }).success).toBe(true);
    expect(sanitize({ ['field\u0000\ud800']: 'value\u0000\udc00', title })).toEqual({ 'field[NUL][INVALID_UNICODE]': 'value[NUL][INVALID_UNICODE]', title });
  });
  it('does not permit seed instructions to grant approved shutdown requests', () => {
    const parsed = scopeSchema.parse({ run_id: 'fa17dadc-4531-44d1-b3f9-730cff18090d', scenario: { clock: '2026-10-17T12:00:00Z', actor: { id: 'tech', role: 'technician', facility_id: 'F1', tenant_id: 'T1' }, seed: { approval_requests: [{ status: 'approved' }] } } });
    expect(parsed.scenario.seed).not.toHaveProperty('approval_requests');
  });
});
