// Local entry: a plain Node server plus an in-process tick. On Vercel, api/index.ts + cron replace this.
import { createServer } from 'node:http';
import { config } from './config.ts';
import { handler } from './server.ts';
const server = createServer((req, res) => { handler(req, res).catch((e) => { console.error(e); res.statusCode = 500; res.end(); }); });
setInterval(() => fetch(`http://localhost:${config.port}/api/tick`, { headers: { authorization: `Bearer ${config.cronSecret}` } }).catch(() => {}), 15_000);
server.listen(config.port, () => console.log(`curfew on ${config.publicUrl} (port ${config.port})${config.dryRun ? ' DRY_RUN demo' : ''}`));
