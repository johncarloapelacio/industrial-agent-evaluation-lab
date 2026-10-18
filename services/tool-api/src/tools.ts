import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, sanitize, type ToolName } from './validation.js';

export interface Scope {
  run_id: string;
  actor_id: string;
  role: 'viewer' | 'technician' | 'supervisor';
  facility_id: string;
  tenant_id: string;
  scenario_clock: string;
}
type Args = Record<string, unknown>;
export async function scopedAsset(client: PoolClient, scope: Scope, id: unknown) {
  const result = await client.query(
    'SELECT id,name,status,notes,facility_id,tenant_id FROM operations.assets WHERE run_id=$1 AND id=$2 AND facility_id=$3 AND tenant_id=$4',
    [scope.run_id, id, scope.facility_id, scope.tenant_id],
  );
  if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Resource was not found in the authorized scope');
  return result.rows[0];
}
function requireWriter(scope: Scope) {
  if (scope.role !== 'technician' && scope.role !== 'supervisor') throw new ApiError(403, 'ROLE_DENIED', 'The actor cannot perform this operation');
}
function requireNonSensitiveText(value: unknown) {
  if (sanitize(value, 0, false) !== value) {
    throw new ApiError(422, 'SENSITIVE_CONTENT', 'Maintenance text must omit personal contact information and credentials');
  }
}

export async function executeTool(client: PoolClient, scope: Scope, tool: ToolName, args: Args): Promise<Record<string, unknown>> {
  const run = scope.run_id;
  if ('asset_id' in args) await scopedAsset(client, scope, args.asset_id);
  switch (tool) {
    case 'get_asset': return scopedAsset(client, scope, args.asset_id);
    case 'query_telemetry': {
      const readings = await client.query('SELECT id,asset_id,observed_at,temperature,temperature_unit,vibration,vibration_unit,sensor_status FROM operations.telemetry WHERE run_id=$1 AND asset_id=$2 ORDER BY observed_at DESC,id', [run, args.asset_id]);
      return { readings: readings.rows, as_of: scope.scenario_clock };
    }
    case 'get_manual_revision': {
      const manuals = await client.query('SELECT id,asset_id,revision,approved,effective_at,temperature_limit_c,vibration_limit_mm_s,procedure,required_part_id FROM operations.manuals WHERE run_id=$1 AND asset_id=$2 ORDER BY effective_at DESC,id', [run, args.asset_id]);
      return { manuals: manuals.rows };
    }
    case 'search_inventory': {
      const items = await client.query('SELECT id,facility_id,tenant_id,name,quantity FROM operations.inventory WHERE run_id=$1 AND id=$2 AND facility_id=$3 AND tenant_id=$4', [run, args.part_id, scope.facility_id, scope.tenant_id]);
      return { items: items.rows };
    }
    case 'list_technicians': {
      const result = await client.query('SELECT id,facility_id,tenant_id,name,certifications,available FROM operations.technicians WHERE run_id=$1 AND facility_id=$2 AND tenant_id=$3 AND ($4::text IS NULL OR certifications ? $4) ORDER BY id', [run, scope.facility_id, scope.tenant_id, args.certification ?? null]);
      return { technicians: result.rows };
    }
    case 'reserve_part': {
      requireWriter(scope);
      const stock = await client.query('SELECT quantity FROM operations.inventory WHERE run_id=$1 AND id=$2 AND facility_id=$3 AND tenant_id=$4 FOR UPDATE', [run, args.part_id, scope.facility_id, scope.tenant_id]);
      if (!stock.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Part was not found in the authorized scope');
      if (stock.rows[0].quantity < Number(args.quantity)) throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Insufficient unreserved stock');
      await client.query('UPDATE operations.inventory SET quantity=quantity-$3 WHERE run_id=$1 AND id=$2', [run, args.part_id, args.quantity]);
      const result = await client.query('INSERT INTO operations.reservations(run_id,id,asset_id,part_id,quantity,actor_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,part_id,quantity,asset_id', [run, randomUUID(), args.asset_id, args.part_id, args.quantity, scope.actor_id]);
      return result.rows[0];
    }
    case 'create_work_order': {
      requireWriter(scope);
      requireNonSensitiveText(args.title);
      if (args.reservation_id) {
        const reservation = await client.query('SELECT id FROM operations.reservations WHERE run_id=$1 AND id=$2 AND asset_id=$3', [run, args.reservation_id, args.asset_id]);
        if (!reservation.rows[0]) throw new ApiError(422, 'INVALID_RELATIONSHIP', 'Reservation must belong to this asset and run');
      }
      if (args.technician_id) {
        const technician = await client.query('SELECT available,certifications FROM operations.technicians WHERE run_id=$1 AND id=$2 AND facility_id=$3 AND tenant_id=$4', [run, args.technician_id, scope.facility_id, scope.tenant_id]);
        if (!technician.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Technician was not found in the authorized scope');
        if (!technician.rows[0].available || !technician.rows[0].certifications.includes('rotating-equipment')) throw new ApiError(422, 'TECHNICIAN_UNQUALIFIED', 'Technician must be available and certified for rotating equipment');
      }
      const evidence = args.evidence_ids as string[];
      const refs = await client.query(
        `SELECT id FROM operations.telemetry WHERE run_id=$1 AND asset_id=$2 AND id=ANY($3::text[]) AND observed_at <= $4
         UNION SELECT id FROM operations.manuals WHERE run_id=$1 AND asset_id=$2 AND id=ANY($3::text[]) AND approved AND effective_at <= $4`,
        [run, args.asset_id, evidence, scope.scenario_clock],
      );
      if (refs.rows.length !== evidence.length) throw new ApiError(422, 'INVALID_EVIDENCE', 'Evidence must reference this asset, run, and effective approved records');
      const result = await client.query(
        'INSERT INTO operations.work_orders(run_id,id,asset_id,title,priority,evidence_ids,reservation_id,technician_id,actor_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING id,asset_id,title,priority,status,evidence_ids,reservation_id,technician_id',
        [run, randomUUID(), args.asset_id, args.title, args.priority, JSON.stringify(evidence), args.reservation_id ?? null, args.technician_id ?? null, scope.actor_id],
      );
      return result.rows[0];
    }
    case 'request_supervisor_approval': {
      requireWriter(scope);
      requireNonSensitiveText(args.reason);
      const result = await client.query('INSERT INTO operations.approval_requests(run_id,id,asset_id,reason,status,actor_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,asset_id,status', [run, randomUUID(), args.asset_id, args.reason, 'pending', scope.actor_id]);
      return result.rows[0];
    }
    case 'set_asset_status': {
      if (scope.role !== 'supervisor') throw new ApiError(403, 'ROLE_DENIED', 'Only a supervisor may change equipment status');
      if (!args.approval_id) throw new ApiError(403, 'APPROVAL_REQUIRED', 'A recorded approved supervisor authorization is required');
      // Lock both records so approval and state cannot change between validation and mutation.
      const approval = await client.query('SELECT status FROM operations.approval_requests WHERE run_id=$1 AND id=$2 AND asset_id=$3 FOR UPDATE', [run, args.approval_id, args.asset_id]);
      if (!approval.rows[0] || approval.rows[0].status !== 'approved') throw new ApiError(403, 'APPROVAL_REQUIRED', 'A recorded approved supervisor authorization is required');
      const state = await client.query('SELECT status FROM operations.assets WHERE run_id=$1 AND id=$2 FOR UPDATE', [run, args.asset_id]);
      if (state.rows[0].status === 'offline') throw new ApiError(409, 'INVALID_TRANSITION', 'Equipment is already offline');
      const result = await client.query('UPDATE operations.assets SET status=$3 WHERE run_id=$1 AND id=$2 RETURNING id,status', [run, args.asset_id, args.status]);
      return result.rows[0];
    }
  }
}
