import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export function timestampToISO(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error('Unsupported PostgreSQL timestamp format');
  const fraction = (match[3] ?? '').padEnd(3, '0');
  const offset = match[4] === '+00' && (!match[5] || match[5] === '00') ? 'Z' : `${match[4]}:${match[5] ?? '00'}`;
  return `${match[1]}T${match[2]}.${fraction}${offset}`;
}

export function createPool(connectionString = process.env.DATABASE_URL ?? 'postgresql://lab:lab@localhost:5432/lab'): pg.Pool {
  // JavaScript Date drops microseconds, which can change whether evidence precedes the scenario clock.
  const types = new pg.TypeOverrides();
  types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, timestampToISO);
  const pool = new pg.Pool({ connectionString, types, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  // pg removes the broken idle connection before raising this error. Handle it
  // here so a database restart does not stop the API or print connection details.
  pool.on('error', () => {
    process.stderr.write('An idle PostgreSQL connection was discarded; subsequent requests will reconnect.\n');
  });
  return pool;
}
export async function migrate(pool: pg.Pool): Promise<void> {
  const path = process.env.SCHEMA_PATH ?? fileURLToPath(new URL('../../../database/schema.sql', import.meta.url));
  const sql = await readFile(path, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('industrial-lab-schema-v1',0))");
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
