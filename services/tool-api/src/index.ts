import { createApp } from './app.js';
import { createPool, migrate } from './db.js';

const pool = createPool();
await migrate(pool);
const server = createApp(pool).listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '127.0.0.1', () => {
  process.stdout.write(`Operational tool API listening on port ${process.env.PORT ?? 3001}\n`);
});
async function stop() { server.close(async () => { await pool.end(); process.exit(0); }); }
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
