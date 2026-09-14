import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { config } from './config.ts';
import { Store } from './store.ts';
import { ingest } from './engine.ts';
import { toPayment, verifyWebhook } from './whop.ts';
import { launchModeActive, setLaunchMode, tick, undo } from './responder.ts';
import { burst } from './simulate.ts';

const store = new Store();
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
}
const json = (res: import('node:http').ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/webhooks/whop') {
      const raw = await readBody(req);
      if (!config.dryRun && !verifyWebhook(req.headers as Record<string, string>, raw)) return json(res, 401, { error: 'bad signature' });
      const evt = JSON.parse(raw);
      if (!store.markSeen(evt.id)) return json(res, 200, { dup: true });
      if (evt.type === 'payment.succeeded' || evt.type === 'payment.failed') {
        const p = toPayment(evt.data);
        if (evt.type === 'payment.failed') p.status = 'failed';
        const v = await ingest(store, p);
        return json(res, 200, { level: v?.level ?? 'unlearned' });
      }
      return json(res, 200, { ignored: evt.type });
    }
    if (url.pathname === '/api/state') {
      const b = store.baseline;
      return json(res, 200, {
        baseline: b, last: store.getKV('last_verdict'), incidents: store.incidents(20),
        launch_until: launchModeActive(store) ? store.getKV('launch_until') : null,
        recent: store.paymentsSince(new Date(Date.now() - 3_600_000).toISOString()).slice(-200),
        config: { refundDelayMin: config.refundDelayMin, windowMin: config.windowMin, immediateRevoke: config.immediateRevoke, dryRun: config.dryRun },
      });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/undo/')) return json(res, 200, undo(store, Number(url.pathname.split('/').pop())));
    if (url.pathname.startsWith('/undo/')) { // one-click from an alert
      undo(store, Number(url.pathname.split('/').pop()));
      res.writeHead(302, { location: '/' }); return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/launch') {
      const { hours } = JSON.parse((await readBody(req)) || '{}');
      setLaunchMode(store, Number(hours ?? 0)); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/simulate' && config.dryRun) {
      const { kind } = JSON.parse((await readBody(req)) || '{}');
      const v = await burst(store, kind === 'launch' ? 'launch' : 'attack');
      return json(res, 200, v);
    }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e); json(res, 500, { error: (e as Error).message });
  }
});

setInterval(() => tick(store).catch(console.error), 15_000);
server.listen(config.port, () => console.log(`tripwire on http://localhost:${config.port}${config.dryRun ? ' (DRY_RUN, no Whop calls)' : ''}`));
