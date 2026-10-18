import { createHash } from 'node:crypto';
import { z } from 'zod';

// PostgreSQL rejects NUL and unpaired surrogates in text or JSON. Valid Unicode,
// including degree signs and emoji, remains allowed.
const databaseText = z.string().refine(value => !/[\u0000\uD800-\uDFFF]/u.test(value), 'Text contains an unsupported Unicode character');
const identifier = databaseText.trim().min(1).max(128);
const uuid = z.uuid().transform(value => value.toLowerCase());
// PostgreSQL rounds longer fractions; rejecting them keeps the stored clock equal to the fixture clock.
const databaseTimestamp = z.iso.datetime({ offset: true }).refine(value => !/\.\d{7}/.test(value), 'Timestamp precision cannot exceed six fractional digits');
const asset = { asset_id: identifier };
export const toolSchemas = {
  get_asset: z.strictObject(asset),
  query_telemetry: z.strictObject(asset),
  get_manual_revision: z.strictObject(asset),
  search_inventory: z.strictObject({ part_id: identifier }),
  list_technicians: z.strictObject({ ...asset, certification: identifier.optional() }),
  reserve_part: z.strictObject({ ...asset, part_id: identifier, quantity: z.number().int().positive().max(10000) }),
  create_work_order: z.strictObject({
    ...asset,
    title: databaseText.trim().min(3).max(300),
    priority: z.enum(['normal', 'urgent']),
    evidence_ids: z.array(identifier).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Evidence IDs must be unique'),
    reservation_id: uuid.optional(),
    technician_id: identifier.optional(),
  }),
  request_supervisor_approval: z.strictObject({ ...asset, reason: databaseText.trim().min(3).max(2000) }),
  set_asset_status: z.strictObject({ ...asset, status: z.literal('offline'), approval_id: uuid.optional() }),
} as const;
export type ToolName = keyof typeof toolSchemas;
export const mutationTools = new Set<ToolName>(['reserve_part', 'create_work_order', 'request_supervisor_approval', 'set_asset_status']);
export function isToolName(name: string): name is ToolName { return Object.hasOwn(toolSchemas, name); }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Sort object keys so a reordered request body keeps the same fingerprint. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

function escapeUnsupportedText(value: string): string {
  return value.replace(/[\u0000\uD800-\uDFFF]/gu, character => character === '\u0000' ? '[NUL]' : '[INVALID_UNICODE]');
}

function redactPrivateText(value: string): string {
  return escapeUnsupportedText(value)
    .replace(/(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, '[REDACTED_PHONE]');
}

/** Mask known identity, credential, and contact fields and recognizable private text. */
export function sanitize(value: unknown, depth = 0, summarize = true): unknown {
  if (depth > 15) return '[TRUNCATED]';
  // Convert Date values before walking object fields so they remain readable timestamps.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return (summarize ? value.slice(0, 200) : value).map(item => sanitize(item, depth + 1, summarize));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return Object.fromEntries((summarize ? entries.slice(0, 100) : entries).map(([key, item]) => {
      // Denied requests can put private text or unsupported characters in keys too.
      const safeKey = redactPrivateText(key);
      return [safeKey,
        /token|secret|password|authorization|cookie|credential|email|phone|contact|user_id|actor_id|employee|api_?key|home_address|personal_address|ssn/i.test(safeKey.replace(/(?<![A-Z])([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_'))
          ? '[REDACTED]' : sanitize(item, depth + 1, summarize)];
    }));
  }
  if (typeof value === 'string') return redactPrivateText(summarize ? value.slice(0, 8000) : value);
  return value;
}

const scopedEntity = { id: identifier, facility_id: identifier, tenant_id: identifier };
export const scopeSchema = z.object({
  run_id: uuid,
  scenario: z.object({
    clock: databaseTimestamp,
    actor: z.object({ id: identifier, role: z.enum(['viewer', 'technician', 'supervisor']), facility_id: identifier, tenant_id: identifier }),
    seed: z.object({
      assets: z.array(z.object({ ...scopedEntity, name: databaseText.max(500), status: z.enum(['running', 'offline', 'degraded', 'standby']), notes: databaseText.max(20000).default('') })).max(1000).default([]),
      telemetry: z.array(z.object({ id: identifier, asset_id: identifier, observed_at: databaseTimestamp, temperature: z.number().finite(), temperature_unit: identifier, vibration: z.number().finite(), vibration_unit: identifier, sensor_status: identifier })).max(10000).default([]),
      manuals: z.array(z.object({ id: identifier, asset_id: identifier, revision: identifier, approved: z.boolean(), effective_at: databaseTimestamp, temperature_limit_c: z.number().finite(), vibration_limit_mm_s: z.number().finite(), procedure: databaseText.max(30000), required_part_id: identifier.nullable().optional() })).max(1000).default([]),
      inventory: z.array(z.object({ ...scopedEntity, name: databaseText.max(500), quantity: z.number().int().nonnegative() })).max(1000).default([]),
      technicians: z.array(z.object({ ...scopedEntity, name: databaseText.max(500), certifications: z.array(identifier).max(100), available: z.boolean() })).max(1000).default([]),
    }),
  }),
});
