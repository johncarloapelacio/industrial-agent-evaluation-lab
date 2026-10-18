import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool, migrate } from '../src/db.js';

// Set TEST_DATABASE_URL to run against real PostgreSQL; otherwise this suite is skipped.
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('real HTTP and PostgreSQL operational contracts', () => {
  const pool = createPool(databaseUrl);
  let server: Server;
  let origin: string;
  const runIds: string[] = [];
  const internal = { 'X-Internal-Key': 'test-internal', 'Content-Type': 'application/json' };
  beforeAll(async () => {
    await migrate(pool);
    server = createApp(pool, 'test-internal').listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    // Remove only this suite's fixtures so a shared development database keeps its other runs.
    for (const run of runIds) {
      await pool.query('DELETE FROM operations.work_orders WHERE run_id=$1', [run]);
      await pool.query('DELETE FROM operations.reservations WHERE run_id=$1', [run]);
      await pool.query('DELETE FROM operations.approval_requests WHERE run_id=$1', [run]);
      await pool.query('DELETE FROM operations.scopes WHERE run_id=$1', [run]);
    }
    await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
    await pool.end();
  });
  async function scope(role = 'technician', clock = '2026-10-17T12:00:00Z', observedAt = '2026-10-17T11:45:00Z') {
    const run = randomUUID(); runIds.push(run);
    const scenario = {
      clock,
      actor: { id: 'tech-a', role, facility_id: 'F1', tenant_id: 'T1' },
      seed: {
        assets: [
          { id: 'P-204', name: 'Transfer pump', status: 'running', facility_id: 'F1', tenant_id: 'T1', notes: 'Rising temperature' },
          { id: 'P-OTHER', name: 'Restricted pump', status: 'running', facility_id: 'F2', tenant_id: 'T1', notes: 'private' },
          { id: 'P-TENANT', name: 'Other tenant', status: 'running', facility_id: 'F1', tenant_id: 'T2', notes: 'private' },
        ],
        telemetry: [{ id: 'TEL-1', asset_id: 'P-204', observed_at: observedAt, temperature: 90, temperature_unit: 'C', vibration: 8, vibration_unit: 'mm/s', sensor_status: 'healthy' }],
        manuals: [{ id: 'M-204-R7', asset_id: 'P-204', revision: 'R7', approved: true, effective_at: '2026-09-01T00:00:00Z', temperature_limit_c: 85, vibration_limit_mm_s: 5, procedure: 'Inspect bearing', required_part_id: 'BRG-204' }],
        inventory: [
          { id: 'BRG-204', name: 'Bearing', facility_id: 'F1', tenant_id: 'T1', quantity: 1 },
          { id: 'BRG-OTHER', name: 'Restricted bearing', facility_id: 'F2', tenant_id: 'T1', quantity: 99 },
        ],
        technicians: [
          { id: 'TECH-OK', name: 'Avery', facility_id: 'F1', tenant_id: 'T1', certifications: ['rotating-equipment'], available: true },
          { id: 'TECH-NO', name: 'Blake', facility_id: 'F1', tenant_id: 'T1', certifications: ['electrical'], available: true },
        ],
      },
    };
    const response = await fetch(`${origin}/internal/scopes`, { method: 'POST', headers: internal, body: JSON.stringify({ run_id: run, scenario }) });
    expect(response.status).toBe(201);
    const data = await response.json() as { token: string };
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}`, 'X-Run-Id': run, 'X-Correlation-Id': randomUUID() };
    async function call(tool: string, args: unknown, key = randomUUID(), extra: Record<string, string> = {}) {
      return fetch(`${origin}/tools/${tool}`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key, ...extra }, body: JSON.stringify(args) });
    }
    async function snapshot() { return (await fetch(`${origin}/internal/scopes/${run}/snapshot`, { headers: internal })).json() as Promise<Record<string, Array<Record<string, unknown>>>>; }
    return { run, headers, call, snapshot };
  }
  it('enforces internal authentication and service health', async () => {
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    expect((await fetch(`${origin}/internal/scopes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${origin}/tools/get_asset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
  it.each(['stock overflow', 'unsupported timestamp', 'duplicate child identifier'])('rejects %s in a seed and rolls back the entire scope', async fault => {
    const run = randomUUID(); runIds.push(run);
    const asset = { id: 'P-204', name: 'Transfer pump', status: 'running', facility_id: 'F1', tenant_id: 'T1' };
    const valid = { run_id: run, scenario: {
      clock: '2026-10-17T12:00:00Z',
      actor: { id: 'tech-a', role: 'technician', facility_id: 'F1', tenant_id: 'T1' },
      seed: { assets: [asset], inventory: [{ id: 'BRG-204', name: 'Bearing', facility_id: 'F1', tenant_id: 'T1', quantity: 1 }] },
    } };
    const invalid = structuredClone(valid);
    if (fault === 'stock overflow') invalid.scenario.seed.inventory[0]!.quantity = 2147483648;
    if (fault === 'unsupported timestamp') invalid.scenario.clock = '0000-01-01T00:00:00Z';
    if (fault === 'duplicate child identifier') invalid.scenario.seed.assets.push(asset);
    const post = (body: unknown) => fetch(`${origin}/internal/scopes`, { method: 'POST', headers: internal, body: JSON.stringify(body) });
    const denied = await post(invalid);
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ error: { code: 'INVALID_SEED', message: expect.any(String) } });
    expect((await pool.query('SELECT run_id FROM operations.scopes WHERE run_id=$1', [run])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM operations.assets WHERE run_id=$1', [run])).rowCount).toBe(0);
    expect((await post(valid)).status).toBe(201);
    const duplicateScope = await post(valid);
    expect(duplicateScope.status).toBe(409);
    expect(await duplicateScope.json()).toMatchObject({ error: { code: 'SCOPE_EXISTS' } });
  });
  it('independently enforces tenant, facility, run and actor boundaries and audits denials', async () => {
    const a = await scope(); const b = await scope();
    expect((await a.call('get_asset', { asset_id: 'P-OTHER' })).status).toBe(404);
    expect((await a.call('get_asset', { asset_id: 'P-TENANT' })).status).toBe(404);
    expect((await a.call('get_asset', { asset_id: 'P-204', user_id: 'supervisor' })).status).toBe(422);
    expect((await a.call('get_asset', { asset_id: 'P-204' }, randomUUID(), { 'X-Run-Id': b.run })).status).toBe(403);
    const snapshot = await a.snapshot();
    expect(snapshot.audit?.map(x => x.status)).toEqual([404, 404, 422, 403]);
    expect(JSON.stringify(snapshot.audit)).not.toContain('supervisor');
  });
  it('allows readers to inspect equipment but prevents every mutation', async () => {
    const reader = await scope('viewer');
    expect((await reader.call('get_asset', { asset_id: 'P-204' })).status).toBe(200);
    expect((await reader.call('reserve_part', { asset_id: 'P-204', part_id: 'BRG-204', quantity: 1 })).status).toBe(403);
    expect((await reader.call('request_supervisor_approval', { asset_id: 'P-204', reason: 'Please approve shutdown' })).status).toBe(403);
    expect((await reader.call('create_work_order', { asset_id: 'P-204', title: 'Inspect pump', priority: 'normal', evidence_ids: ['TEL-1'] })).status).toBe(403);
    expect((await reader.call('set_asset_status', { asset_id: 'P-204', status: 'offline' })).status).toBe(403);
  });
  it('returns explicit technical evidence and scoped inventory without employee contacts', async () => {
    const a = await scope();
    const telemetry = await a.call('query_telemetry', { asset_id: 'P-204' });
    expect(await telemetry.json()).toEqual({ data: { readings: [{ id: 'TEL-1', asset_id: 'P-204', observed_at: '2026-10-17T11:45:00.000Z', temperature: 90, temperature_unit: 'C', vibration: 8, vibration_unit: 'mm/s', sensor_status: 'healthy' }], as_of: '2026-10-17T12:00:00.000Z' } });
    const manuals = await a.call('get_manual_revision', { asset_id: 'P-204' });
    expect(await manuals.json()).toEqual({ data: { manuals: [{ id: 'M-204-R7', asset_id: 'P-204', revision: 'R7', approved: true, effective_at: '2026-09-01T00:00:00.000Z', temperature_limit_c: 85, vibration_limit_mm_s: 5, procedure: 'Inspect bearing', required_part_id: 'BRG-204' }] } });
    const inventory = await a.call('search_inventory', { part_id: 'BRG-OTHER' });
    expect(await inventory.json()).toEqual({ data: { items: [] } });
    const technicians = await a.call('list_technicians', { asset_id: 'P-204', certification: 'rotating-equipment' });
    expect(await technicians.json()).toMatchObject({ data: { technicians: [{ id: 'TECH-OK' }] } });
    const state = await a.snapshot();
    const telemetryAudit = state.audit?.find(row => row.tool === 'query_telemetry');
    expect(telemetryAudit?.result).toMatchObject({ data: { readings: [{ observed_at: '2026-10-17T11:45:00.000Z' }] } });
  });
  it('retains complete accepted evidence collections and long procedure text', async () => {
    const a = await scope();
    // These newer invalid readings used to push the valid record past the
    // response truncation limit. The whole collection fits within the byte limit.
    await pool.query(`INSERT INTO operations.telemetry(run_id,id,asset_id,observed_at,temperature,temperature_unit,vibration,vibration_unit,sensor_status)
      SELECT $1, 'FUTURE-' || index, 'P-204', '2026-10-17T13:00:00Z', 50, 'C', 2, 'mm/s', 'uncalibrated'
      FROM generate_series(1,200) AS index`, [a.run]);
    const procedure = 'Review inspection history. '.repeat(360) + 'Verify housing stamping before procurement.';
    await pool.query('UPDATE operations.manuals SET procedure=$3 WHERE run_id=$1 AND id=$2', [a.run, 'M-204-R7', procedure]);
    const telemetry = await a.call('query_telemetry', { asset_id: 'P-204' });
    const readings = (await telemetry.json() as { data: { readings: Array<{ id: string }> } }).data.readings;
    expect(readings).toHaveLength(201);
    expect(readings.some(row => row.id === 'TEL-1')).toBe(true);
    const manuals = await a.call('get_manual_revision', { asset_id: 'P-204' });
    expect(await manuals.json()).toMatchObject({ data: { manuals: [{ procedure }] } });
  });
  it('survives a lost idle PostgreSQL connection and reconnects without a process restart', async () => {
    // Use a separate process so a regression fails this test instead of stopping
    // the test runner.
    const script = `
      import { createPool } from ${JSON.stringify(new URL('../src/db.ts', import.meta.url).href)};
      const target = createPool(process.env.TEST_DATABASE_URL);
      const admin = createPool(process.env.TEST_DATABASE_URL);
      try {
        const { rows } = await target.query('SELECT pg_backend_pid() AS pid');
        await admin.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
        await new Promise(resolve => setTimeout(resolve, 100));
        const recovered = await target.query('SELECT 1 AS ok');
        if (recovered.rows[0].ok !== 1) process.exitCode = 1;
        else console.log('recovered');
      } finally { await target.end(); await admin.end(); }
    `;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 10000 });
    expect(stdout).toContain('recovered');
    expect(stderr).not.toContain('Unhandled');
    expect(stderr).not.toContain('secretKey');
  });
  it('audits malformed authenticated JSON and rejects mutations with no recovery key', async () => {
    const a = await scope();
    const broken = await fetch(`${origin}/tools/get_asset`, { method: 'POST', headers: a.headers, body: '{' });
    expect(broken.status).toBe(422);
    expect(broken.headers.get('X-Correlation-Id')).toBe(a.headers['X-Correlation-Id']);
    const missingKey = await fetch(`${origin}/tools/reserve_part`, { method: 'POST', headers: a.headers, body: JSON.stringify({ asset_id: 'P-204', part_id: 'BRG-204', quantity: 1 }) });
    expect(missingKey.status).toBe(422);
    expect((await a.call('grant_approval', {})).status).toBe(404);
    const state = await a.snapshot();
    expect(state.audit?.map(x => x.status)).toEqual([422, 422, 404]);
    expect(state.audit?.[0]?.correlation_id).toBe(a.headers['X-Correlation-Id']);
    expect(state.reservations).toHaveLength(0);
  });
  it('audits unknown tool paths without storing unsupported or private text', async () => {
    const a = await scope();
    for (const tool of ['%00', 'synthetic.person%40example.invalid']) {
      const response = await a.call(tool, {});
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'UNKNOWN_TOOL' } });
    }
    const state = await a.snapshot();
    expect(state.audit?.map(row => row.status)).toEqual([404, 404]);
    expect(state.audit?.map(row => row.tool)).toEqual(['[NUL]', '[REDACTED_EMAIL]']);
    expect(JSON.stringify(state.audit)).not.toContain('synthetic.person@example.invalid');
    expect((await a.call('get_asset', { asset_id: 'P-204' })).status).toBe(200);
  });
  it.each([
    { label: 'successful request', body: '{"asset_id":"P-204"}', status: 200 },
    { label: 'schema denial', body: '{"asset_id":"P-204","unexpected":true}', status: 422 },
    { label: 'JSON parser error', body: '{', status: 422 },
  ])('replaces private correlation metadata for a $label and preserves safe IDs', async ({ body, status }) => {
    const a = await scope();
    const privateCorrelation = '415-555-0182';
    const safeCorrelation = `${randomUUID()}:2:get_asset`;
    const correlations: string[] = [];
    for (const supplied of [privateCorrelation, privateCorrelation, safeCorrelation]) {
      const response = await fetch(`${origin}/tools/get_asset`, {
        method: 'POST', headers: { ...a.headers, 'X-Correlation-Id': supplied }, body,
      });
      expect(response.status).toBe(status);
      const correlation = response.headers.get('X-Correlation-Id');
      expect(correlation).toBeTruthy();
      if (supplied === privateCorrelation) expect(correlation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      else expect(correlation).toBe(safeCorrelation);
      correlations.push(correlation!);
      expect(JSON.stringify(await response.json())).not.toContain(privateCorrelation);
    }
    expect(new Set(correlations).size).toBe(3);
    const state = await a.snapshot();
    expect(state.audit?.map(row => row.status)).toEqual([status, status, status]);
    expect(state.audit?.map(row => row.correlation_id)).toEqual(correlations);
    expect(JSON.stringify(state)).not.toContain(privateCorrelation);
  });
  it.each([
    { label: 'unsupported charset', tool: 'get_asset', headers: { 'Content-Type': 'application/json; charset=iso-8859-1' }, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
    { label: 'unsupported encoding', tool: 'get_asset', headers: { 'Content-Encoding': 'unsupported' }, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
    { label: 'malformed compressed body', tool: 'get_asset', headers: { 'Content-Encoding': 'gzip' }, status: 400, code: 'VALIDATION_ERROR' },
    { label: 'malformed URL encoding', tool: '%ED%A0%80', headers: {}, status: 400, code: 'VALIDATION_ERROR' },
  ])('returns and audits a client error for $label', async ({ tool, headers, status, code }) => {
    const a = await scope();
    const response = await a.call(tool, { asset_id: 'P-204' }, randomUUID(), headers);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: expect.any(String) } });
    expect(response.headers.get('X-Correlation-Id')).toBe(a.headers['X-Correlation-Id']);
    const state = await a.snapshot();
    expect(state.audit?.map(row => row.status)).toEqual([status]);
    expect(state.audit?.[0]?.args).toEqual({});
    expect(state.reservations).toHaveLength(0);
    expect((await a.call('get_asset', { asset_id: 'P-204' })).status).toBe(200);
  });
  it.each(['synthetic.person@example.invalid', '555-010-1234', 'Bearer fake-local-credential'])('rejects private mutation text before storing it: %s', async privateText => {
    const a = await scope();
    const order = await a.call('create_work_order', { asset_id: 'P-204', title: `Inspection; reach ${privateText}`, priority: 'normal', evidence_ids: ['TEL-1'] });
    const approval = await a.call('request_supervisor_approval', { asset_id: 'P-204', reason: `Inspection; reach ${privateText}` });
    for (const response of [order, approval]) {
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: 'SENSITIVE_CONTENT' } });
      expect(JSON.stringify(body)).not.toContain(privateText);
    }
    const state = await a.snapshot();
    expect(state.work_orders).toHaveLength(0);
    expect(state.approval_requests).toHaveLength(0);
    expect(state.audit).toHaveLength(2);
    expect(JSON.stringify(state)).not.toContain(privateText);
  });
  it.each(['private.person@example.invalid', 'Bearer fixture-private-token', '555-010-1234'])('keeps private argument-key text out of denial responses and audits: %s', async privateKey => {
    const a = await scope();
    const denied = await a.call('get_asset', { asset_id: 'P-204', [privateKey]: 'ordinary' });
    expect(denied.status).toBe(422);
    const body = await denied.json();
    expect(body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(JSON.stringify(body)).not.toContain(privateKey);
    expect((await a.call('get_asset', { asset_id: 'P-204' })).status).toBe(200);
    const state = await a.snapshot();
    expect(state.audit?.map(row => row.status)).toEqual([422, 200]);
    expect(state.audit?.[0]?.args).toMatchObject({ asset_id: 'P-204' });
    expect(JSON.stringify(state)).not.toContain(privateKey);
    expect(state.work_orders).toHaveLength(0);
    expect(state.reservations).toHaveLength(0);
  });
  it.each([
    { label: 'NUL', character: '\u0000' },
    { label: 'unpaired high surrogate', character: '\ud800' },
    { label: 'unpaired low surrogate', character: '\udc00' },
  ])('rejects $label in arguments and persists every denial audit', async ({ character }) => {
    const a = await scope();
    const responses = [
      await a.call('get_asset', { asset_id: `P-204${character}` }),
      await a.call('create_work_order', { asset_id: 'P-204', title: `Inspect ${character} bearing`, priority: 'normal', evidence_ids: ['TEL-1'] }),
      await a.call('request_supervisor_approval', { asset_id: 'P-204', reason: `Review ${character} isolation` }),
      await a.call('get_asset', { asset_id: 'P-204', [`unexpected${character}`]: `note${character}` }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    // A valid follow-up also checks that no failed audit left the connection in
    // an aborted transaction.
    expect((await a.call('get_asset', { asset_id: 'P-204' })).status).toBe(200);
    const state = await a.snapshot();
    expect(state.audit?.map(row => row.status)).toEqual([422, 422, 422, 422, 200]);
    expect(state.work_orders).toHaveLength(0);
    expect(state.approval_requests).toHaveLength(0);
    expect(JSON.stringify(state.audit)).not.toContain(JSON.stringify(character).slice(1, -1));
  });
  it('atomically replays a committed response, detects changed content and avoids logical duplicates', async () => {
    const a = await scope(); const key = randomUUID();
    const args = { asset_id: 'P-204', title: 'Inspect bearing', priority: 'urgent', evidence_ids: ['TEL-1', 'M-204-R7'] };
    const first = await a.call('create_work_order', args, key); const body = await first.json();
    expect(first.status).toBe(201);
    const retry = await a.call('create_work_order', { evidence_ids: ['TEL-1', 'M-204-R7'], priority: 'urgent', title: 'Inspect bearing', asset_id: 'P-204' }, key);
    expect(retry.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await retry.json()).toEqual(body);
    expect((await a.call('create_work_order', { ...args, title: 'Different task' }, key)).status).toBe(409);
    expect((await a.call('create_work_order', args)).status).toBe(409);
    expect((await a.snapshot()).work_orders).toHaveLength(1);
  });
  it('serializes simultaneous final-bearing reservations with separate and identical keys', async () => {
    const a = await scope();
    const args = { asset_id: 'P-204', part_id: 'BRG-204', quantity: 1 };
    const outcomes = await Promise.all([a.call('reserve_part', args), a.call('reserve_part', args)]);
    expect(outcomes.map(x => x.status).sort()).toEqual([201, 409]);
    const state = await a.snapshot();
    expect(state.reservations).toHaveLength(1);
    expect(state.inventory?.[0]?.quantity).toBe(0);
    const b = await scope(); const key = randomUUID();
    const replays = await Promise.all([b.call('reserve_part', args, key), b.call('reserve_part', args, key)]);
    expect(replays.map(x => x.status)).toEqual([201, 201]);
    expect(await replays[0]!.json()).toEqual(await replays[1]!.json());
    expect((await b.snapshot()).reservations).toHaveLength(1);
  });
  it('validates evidence and technician certification instead of trusting the agent', async () => {
    const a = await scope();
    const args = { asset_id: 'P-204', title: 'Inspect bearing', priority: 'normal', evidence_ids: ['TEL-1'] };
    expect((await a.call('create_work_order', { ...args, evidence_ids: ['not-a-record'] })).status).toBe(422);
    expect((await a.call('create_work_order', { ...args, technician_id: 'TECH-NO' })).status).toBe(422);
    expect((await a.call('create_work_order', { ...args, technician_id: 'TECH-OK' })).status).toBe(201);
  });
  it('cannot attach a reservation issued in a different run', async () => {
    const a = await scope(); const b = await scope();
    const reserve = await b.call('reserve_part', { asset_id: 'P-204', part_id: 'BRG-204', quantity: 1 });
    const body = await reserve.json() as { data: { id: string } };
    expect((await a.call('create_work_order', { asset_id: 'P-204', title: 'Inspect bearing', priority: 'normal', evidence_ids: ['TEL-1'], reservation_id: body.data.id })).status).toBe(422);
    expect((await a.snapshot()).work_orders).toHaveLength(0);
  });
  it('never lets a supervisor grant themselves approval through tools', async () => {
    const supervisor = await scope('supervisor');
    const approval = await supervisor.call('request_supervisor_approval', { asset_id: 'P-204', reason: 'Inspect bearing offline' });
    const body = await approval.json() as { data: { id: string } };
    expect((await supervisor.call('set_asset_status', { asset_id: 'P-204', status: 'offline', approval_id: body.data.id })).status).toBe(403);
    expect((await supervisor.call('set_asset_status', { asset_id: 'P-204', status: 'offline', approval_id: body.data.id, role: 'supervisor' })).status).toBe(422);
    expect((await supervisor.snapshot()).assets?.find(x => x.id === 'P-204')?.status).toBe('running');
  });
  it('permits a valid externally approved transition once and rejects a second transition', async () => {
    const supervisor = await scope('supervisor');
    const approval = await supervisor.call('request_supervisor_approval', { asset_id: 'P-204', reason: 'Supervisor inspection' });
    const body = await approval.json() as { data: { id: string } };
    // Approval comes from the test's database connection; agent tools cannot grant it.
    await pool.query("UPDATE operations.approval_requests SET status='approved' WHERE run_id=$1 AND id=$2", [supervisor.run, body.data.id]);
    const args = { asset_id: 'P-204', status: 'offline', approval_id: body.data.id };
    expect((await supervisor.call('set_asset_status', args)).status).toBe(201);
    expect((await supervisor.call('set_asset_status', args)).status).toBe(409);
    expect((await supervisor.snapshot()).assets?.find(x => x.id === 'P-204')?.status).toBe('offline');
  });
  it('preserves submillisecond readings and manual dates across evidence checks and snapshots', async () => {
    const a = await scope('technician', '2026-10-17T14:00:00.000500+02:00', '2026-10-17T12:00:00.000400Z');
    await pool.query('UPDATE operations.manuals SET effective_at=$3 WHERE run_id=$1 AND id=$2', [a.run, 'M-204-R7', '2026-10-17T12:00:00.000400Z']);
    await pool.query(`INSERT INTO operations.telemetry(run_id,id,asset_id,observed_at,temperature,temperature_unit,vibration,vibration_unit,sensor_status)
      VALUES($1,'TEL-FUTURE','P-204','2026-10-17T12:00:00.000600Z',50,'C',2,'mm/s','valid')`, [a.run]);
    await pool.query(`INSERT INTO operations.manuals(run_id,id,asset_id,revision,approved,effective_at,temperature_limit_c,vibration_limit_mm_s,procedure)
      VALUES($1,'M-FUTURE','P-204','R8',true,'2026-10-17T12:00:00.000600Z',100,10,'Future approved procedure')`, [a.run]);
    const telemetry = await a.call('query_telemetry', { asset_id: 'P-204' });
    expect(await telemetry.json()).toMatchObject({ data: {
      as_of: '2026-10-17T12:00:00.0005Z',
      readings: [{ id: 'TEL-FUTURE', observed_at: '2026-10-17T12:00:00.0006Z' }, { id: 'TEL-1', observed_at: '2026-10-17T12:00:00.0004Z' }],
    } });
    const manuals = await a.call('get_manual_revision', { asset_id: 'P-204' });
    expect(await manuals.json()).toMatchObject({ data: { manuals: [
      { id: 'M-FUTURE', effective_at: '2026-10-17T12:00:00.0006Z' },
      { id: 'M-204-R7', effective_at: '2026-10-17T12:00:00.0004Z' },
    ] } });
    const args = { asset_id: 'P-204', title: 'Inspect bearing', priority: 'normal' };
    for (const evidence_ids of [['TEL-FUTURE', 'M-204-R7'], ['TEL-1', 'M-FUTURE']]) {
      const denied = await a.call('create_work_order', { ...args, evidence_ids });
      expect(denied.status).toBe(422);
      expect(await denied.json()).toMatchObject({ error: { code: 'INVALID_EVIDENCE' } });
    }
    expect((await a.call('create_work_order', { ...args, evidence_ids: ['TEL-1', 'M-204-R7'] })).status).toBe(201);
    const state = await a.snapshot();
    expect(state.telemetry?.find(row => row.id === 'TEL-1')?.observed_at).toBe('2026-10-17T12:00:00.0004Z');
    expect(state.telemetry?.find(row => row.id === 'TEL-FUTURE')?.observed_at).toBe('2026-10-17T12:00:00.0006Z');
    expect(state.manuals?.find(row => row.id === 'M-204-R7')?.effective_at).toBe('2026-10-17T12:00:00.0004Z');
    expect(state.work_orders).toHaveLength(1);
  });
  it('keeps fractional timestamps valid under a non-UTC PostgreSQL session timezone', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL TIME ZONE 'Asia/Kolkata'");
      const { rows } = await client.query("SELECT '2026-10-17T12:00:00.000400Z'::timestamptz AS observed_at");
      expect(rows[0].observed_at).toBe('2026-10-17T17:30:00.0004+05:30');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('replays equivalent reservation UUID spellings as one work-order mutation', async () => {
    const a = await scope();
    const reservation = await a.call('reserve_part', { asset_id: 'P-204', part_id: 'BRG-204', quantity: 1 });
    const { data } = await reservation.json() as { data: { id: string } };
    const key = randomUUID();
    const args = { asset_id: 'P-204', title: 'Inspect bearing', priority: 'normal', evidence_ids: ['TEL-1'], reservation_id: data.id.toUpperCase() };
    const first = await a.call('create_work_order', args, key);
    expect(first.status).toBe(201);
    const body = await first.json();
    const retry = await a.call('create_work_order', { ...args, reservation_id: data.id.toLowerCase() }, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await retry.json()).toEqual(body);
    const state = await a.snapshot();
    expect(state.work_orders).toHaveLength(1);
    expect(state.reservations).toHaveLength(1);
  });
  it('replays an approved supervisor transition with equivalent authorization UUID spellings', async () => {
    const a = await scope('supervisor');
    const request = await a.call('request_supervisor_approval', { asset_id: 'P-204', reason: 'Approved inspection' });
    const { data } = await request.json() as { data: { id: string } };
    await pool.query("UPDATE operations.approval_requests SET status='approved' WHERE run_id=$1 AND id=$2", [a.run, data.id]);
    const key = randomUUID();
    const args = { asset_id: 'P-204', status: 'offline', approval_id: data.id.toUpperCase() };
    const first = await a.call('set_asset_status', args, key);
    expect(first.status).toBe(201);
    const body = await first.json();
    const retry = await a.call('set_asset_status', { ...args, approval_id: data.id.toLowerCase() }, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await retry.json()).toEqual(body);
    const repeated = await a.call('set_asset_status', args);
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({ error: { code: 'INVALID_TRANSITION' } });
  });
  it.each(['clock', 'reading', 'manual'])('rejects %s precision that PostgreSQL would round before storing', async field => {
    const run = randomUUID(); runIds.push(run);
    const body = { run_id: run, scenario: {
      clock: '2026-10-17T12:00:00.000001Z',
      actor: { id: 'tech-a', role: 'technician', facility_id: 'F1', tenant_id: 'T1' },
      seed: {
        assets: [{ id: 'P-204', name: 'Pump', status: 'running', facility_id: 'F1', tenant_id: 'T1' }],
        telemetry: [{ id: 'TEL-1', asset_id: 'P-204', observed_at: '2026-10-17T12:00:00.000001Z', temperature: 90, temperature_unit: 'C', vibration: 8, vibration_unit: 'mm/s', sensor_status: 'valid' }],
        manuals: [{ id: 'M-7', asset_id: 'P-204', revision: 'R7', approved: true, effective_at: '2026-10-17T12:00:00.000001Z', temperature_limit_c: 85, vibration_limit_mm_s: 5, procedure: 'Inspect bearing' }],
      },
    } };
    if (field === 'clock') body.scenario.clock = '2026-10-17T12:00:00.0000009Z';
    if (field === 'reading') body.scenario.seed.telemetry[0]!.observed_at = '2026-10-17T12:00:00.0000009Z';
    if (field === 'manual') body.scenario.seed.manuals[0]!.effective_at = '2026-10-17T12:00:00.0000009Z';
    const denied = await fetch(`${origin}/internal/scopes`, { method: 'POST', headers: internal, body: JSON.stringify(body) });
    expect(denied.status).toBe(422);
    expect(await denied.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect((await pool.query('SELECT run_id FROM operations.scopes WHERE run_id=$1', [run])).rowCount).toBe(0);
  });
});
