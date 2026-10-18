import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { executeTool, type Scope } from './tools.js';
import { ApiError, fingerprint, isToolName, mutationTools, sanitize, scopeSchema, toolSchemas } from './validation.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const internalEqual = (input: string | undefined, key: string) => !!input && timingSafeEqual(Buffer.from(hash(input)), Buffer.from(hash(key)));
const errorBody = (code: string, message: string) => ({ error: { code, message } });

function correlationId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) && sanitize(value) === value ? value : randomUUID();
}

async function audit(client: PoolClient | Pool, scope: Scope, tool: string, status: number, args: unknown, result: unknown, correlation: string) {
  // Unknown tool names come from the URL and need the same treatment as arguments.
  await client.query('INSERT INTO operations.audit(id,run_id,actor_id,tool,status,args,result,correlation_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)', [randomUUID(), scope.run_id, scope.actor_id, sanitize(tool), status, JSON.stringify(sanitize(args ?? {})), JSON.stringify(sanitize(result)), correlation]);
}

export function createApp(pool: Pool, internalKey = process.env.LAB_INTERNAL_KEY ?? 'local-internal-key') {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb', strict: true }));
  app.get('/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'connected' }); }
    catch { res.status(503).json(errorBody('DATABASE_UNAVAILABLE', 'Database is unavailable')); }
  });
  app.use('/internal', (req, res, next) => {
    if (!internalEqual(req.get('X-Internal-Key'), internalKey)) { res.status(401).json(errorBody('UNAUTHORIZED', 'Internal authentication is required')); return; }
    next();
  });
  app.post('/internal/scopes', async (req, res) => {
    const parsed = scopeSchema.safeParse(req.body);
    if (!parsed.success) { res.status(422).json(errorBody('VALIDATION_ERROR', 'Scope seed does not match the scenario schema')); return; }
    const { run_id: run, scenario } = parsed.data;
    const token = randomBytes(32).toString('base64url');
    const actor = scenario.actor;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO operations.scopes(run_id,token_hash,actor_id,role,facility_id,tenant_id,scenario_clock) VALUES($1,$2,$3,$4,$5,$6,$7)', [run, hash(token), actor.id, actor.role, actor.facility_id, actor.tenant_id, scenario.clock]);
      for (const x of scenario.seed.assets) await client.query('INSERT INTO operations.assets(run_id,id,facility_id,tenant_id,name,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7)', [run, x.id, x.facility_id, x.tenant_id, x.name, x.status, x.notes]);
      for (const x of scenario.seed.telemetry) await client.query('INSERT INTO operations.telemetry(run_id,id,asset_id,observed_at,temperature,temperature_unit,vibration,vibration_unit,sensor_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [run, x.id, x.asset_id, x.observed_at, x.temperature, x.temperature_unit, x.vibration, x.vibration_unit, x.sensor_status]);
      for (const x of scenario.seed.manuals) await client.query('INSERT INTO operations.manuals(run_id,id,asset_id,revision,approved,effective_at,temperature_limit_c,vibration_limit_mm_s,procedure,required_part_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [run, x.id, x.asset_id, x.revision, x.approved, x.effective_at, x.temperature_limit_c, x.vibration_limit_mm_s, x.procedure, x.required_part_id ?? null]);
      for (const x of scenario.seed.inventory) await client.query('INSERT INTO operations.inventory(run_id,id,facility_id,tenant_id,name,quantity) VALUES($1,$2,$3,$4,$5,$6)', [run, x.id, x.facility_id, x.tenant_id, x.name, x.quantity]);
      for (const x of scenario.seed.technicians) await client.query('INSERT INTO operations.technicians(run_id,id,facility_id,tenant_id,name,certifications,available) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)', [run, x.id, x.facility_id, x.tenant_id, x.name, JSON.stringify(x.certifications), x.available]);
      await client.query('COMMIT');
      res.status(201).json({ token, actor });
    } catch (error) {
      await client.query('ROLLBACK');
      const { code, constraint } = error as { code?: string; constraint?: string };
      if (code === '23505' && constraint === 'scopes_pkey') res.status(409).json(errorBody('SCOPE_EXISTS', 'This run scope already exists'));
      else if (['23503', '23505', '23514'].includes(code ?? '') || code?.startsWith('22')) res.status(422).json(errorBody('INVALID_SEED', 'Scenario seed contains inconsistent entities or unsupported values'));
      else res.status(500).json(errorBody('INTERNAL_ERROR', 'The scenario scope could not be created'));
    } finally { client.release(); }
  });
  app.get('/internal/scopes/:run_id/snapshot', async (req, res) => {
    const valid = scopeSchema.shape.run_id.safeParse(req.params.run_id);
    if (!valid.success) { res.status(422).json(errorBody('VALIDATION_ERROR', 'A UUID run ID is required')); return; }
    const exists = await pool.query('SELECT run_id FROM operations.scopes WHERE run_id=$1', [valid.data]);
    if (!exists.rows.length) { res.status(404).json(errorBody('NOT_FOUND', 'Run scope was not found')); return; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot: Record<string, unknown> = {};
      for (const table of ['assets', 'telemetry', 'manuals', 'inventory', 'technicians', 'reservations', 'work_orders', 'approval_requests', 'audit']) {
        // Table names come from this fixed list; request values stay in SQL parameters.
        const result = await client.query(`SELECT * FROM operations.${table} WHERE run_id=$1 ORDER BY ${table === 'audit' ? 'created_at,id' : 'id'}`, [valid.data]);
        snapshot[table] = result.rows;
      }
      await client.query('COMMIT');
      res.json(snapshot);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
  app.post('/tools/:name', async (req: Request, res: Response) => {
    const rawToken = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('Authorization') ?? '')?.[1];
    if (!rawToken) { res.status(401).json(errorBody('UNAUTHORIZED', 'A run credential is required')); return; }
    const auth = await pool.query<Scope>('SELECT run_id,actor_id,role,facility_id,tenant_id,scenario_clock FROM operations.scopes WHERE token_hash=$1', [hash(rawToken)]);
    const scope = auth.rows[0];
    if (!scope) { res.status(401).json(errorBody('UNAUTHORIZED', 'Run credential is invalid')); return; }
    const correlation = correlationId(req.get('X-Correlation-Id'));
    res.set('X-Correlation-Id', correlation);
    const tool = String(req.params.name).slice(0, 128);
    let client: PoolClient | undefined;
    let activeTransaction = false;
    try {
      if ((req.get('X-Run-Id') ?? '').toLowerCase() !== scope.run_id) throw new ApiError(403, 'RUN_SCOPE_DENIED', 'Credential cannot be used for this run');
      if (!isToolName(tool)) throw new ApiError(404, 'UNKNOWN_TOOL', 'Requested tool is not available');
      const parsed = toolSchemas[tool].safeParse(req.body);
      if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Tool arguments must match the schema; identity and scope fields cannot be supplied');
      const args = parsed.data;
      const mutation = mutationTools.has(tool);
      const key = req.get('Idempotency-Key');
      if (mutation && (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))) throw new ApiError(422, 'IDEMPOTENCY_REQUIRED', 'A 1-128 character Idempotency-Key is required for mutations');
      client = await pool.connect();
      await client.query('BEGIN'); activeTransaction = true;
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      const digest = fingerprint(args);
      if (mutation) {
        // Wait for any matching request to finish before checking its saved
        // response. This lock lasts until the mutation and response commit together.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([scope.run_id, scope.actor_id, tool, key])]);
        const stored = await client.query('SELECT fingerprint,response,response_status FROM operations.idempotency WHERE run_id=$1 AND actor_id=$2 AND tool=$3 AND key=$4', [scope.run_id, scope.actor_id, tool, key]);
        if (stored.rows[0]) {
          if (stored.rows[0].fingerprint !== digest) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with different arguments');
          const saved = stored.rows[0];
          await audit(client, scope, tool, saved.response_status, args, saved.response, correlation);
          await client.query('COMMIT'); activeTransaction = false;
          res.set('Idempotency-Replayed', 'true').status(saved.response_status).json(saved.response); return;
        }
      }
      // Keep complete technical evidence in tool responses. Truncating a record
      // list or procedure could hide the observation or instruction the agent needs.
      const data = sanitize(await executeTool(client, scope, tool, args), 0, false);
      const body = { data };
      const status = mutation ? 201 : 200;
      if (mutation) await client.query('INSERT INTO operations.idempotency(run_id,actor_id,tool,key,fingerprint,response,response_status) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)', [scope.run_id, scope.actor_id, tool, key, digest, JSON.stringify(body), status]);
      await audit(client, scope, tool, status, args, body, correlation);
      await client.query('COMMIT'); activeTransaction = false;
      res.status(status).json(body);
    } catch (error) {
      if (client && activeTransaction) await client.query('ROLLBACK');
      const dbCode = (error as { code?: string }).code;
      const apiError = error instanceof ApiError ? error : dbCode === '23505'
        ? new ApiError(409, 'WORKFLOW_CONFLICT', 'A work order already exists for this asset workflow')
        : ['55P03', '57014', '40P01', '40001'].includes(dbCode ?? '')
          ? new ApiError(409, 'CONCURRENT_CONFLICT', 'Concurrent operation must be retried with the same idempotency key')
          : new ApiError(500, 'INTERNAL_ERROR', 'The tool operation could not be completed');
      const body = errorBody(apiError.code, apiError.message);
      // Reuse this connection for the denial audit. Asking for another can leave
      // every request waiting while it still holds a connection.
      await audit(client ?? pool, scope, tool, apiError.status, req.body, body, correlation);
      res.status(apiError.status).json(body);
    } finally { client?.release(); }
  });
  app.use((_req, res) => { res.status(404).json(errorBody('NOT_FOUND', 'Endpoint was not found')); });
  const handleError: ErrorRequestHandler = async (error, req, res, _next) => {
    let status = 500;
    let body = errorBody('INTERNAL_ERROR', 'The request could not be completed');
    if (error?.type === 'entity.parse.failed') { status = 422; body = errorBody('VALIDATION_ERROR', 'Request body must be valid JSON'); }
    else if (error?.type === 'entity.too.large') { status = 413; body = errorBody('BODY_TOO_LARGE', 'Request body exceeds the configured limit'); }
    else if (['charset.unsupported', 'encoding.unsupported'].includes(error?.type)) { status = 415; body = errorBody('UNSUPPORTED_MEDIA_TYPE', 'Request encoding is not supported'); }
    else if (error instanceof URIError || error?.status === 400) { status = 400; body = errorBody('VALIDATION_ERROR', 'Request URL or body is malformed'); }
    // The JSON parser runs before authentication. Identify the run before logging
    // a malformed request, and keep its raw body out of the audit.
    const toolMatch = /^\/tools\/([^/?]{1,128})/.exec(req.path);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('Authorization') ?? '')?.[1];
    if (toolMatch && token && status !== 500) {
      try {
        const auth = await pool.query<Scope>('SELECT run_id,actor_id,role,facility_id,tenant_id,scenario_clock FROM operations.scopes WHERE token_hash=$1', [hash(token)]);
        if (auth.rows[0]) {
          const correlation = correlationId(req.get('X-Correlation-Id'));
          res.set('X-Correlation-Id', correlation);
          await audit(pool, auth.rows[0], toolMatch[1]!, status, {}, body, correlation);
        }
      } catch { status = 500; body = errorBody('INTERNAL_ERROR', 'The request could not be completed'); }
    }
    res.status(status).json(body);
  };
  app.use(handleError);
  return app;
}
