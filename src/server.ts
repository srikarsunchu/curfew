import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { config, DEMO_TENANT } from './config.ts';
import { createStore, type Store } from './store.ts';
import { ingest } from './engine.ts';
import { decrypt } from './crypto.ts';
import { toPayment, verifyWebhook, WhopError, REQUIRED_PERMISSIONS } from './whop.ts';
import { act, launchModeActive, setLaunchMode, tick, undo } from './responder.ts';
import { connect, ctxFor, disconnect, learn, type Ctx, type LearnStatus } from './tenant.ts';
import { burst, resetBurst } from './simulate.ts';
import { ensureDemoTenant } from './demo.ts';

const store: Store = createStore();
const booted = config.dryRun ? ensureDemoTenant(store).then(() => undefined) : Promise.resolve();
const page = (name: string) => readFileSync(new URL(`../views/${name}`, import.meta.url), 'utf8');
const pages = { app: page('index.html'), landing: page('landing.html'), connect: page('connect.html') };

const COOKIE = 'curfew_owner';
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    // Vercel may have parsed the body already
    const pre = (req as any).body;
    if (pre !== undefined && pre !== null) return res(typeof pre === 'string' ? pre : Buffer.isBuffer(pre) ? pre.toString('utf8') : JSON.stringify(pre));
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) rej(new Error('body too large')); }); req.on('end', () => res(b));
  });
}
const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const html = (res: ServerResponse, body: string, code = 200) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const redirect = (res: ServerResponse, to: string, headers: Record<string, string> = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };
const setCookie = (token: string, maxAge = 60 * 60 * 24 * 365) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
function cookieToken(req: IncomingMessage): string | null {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]!) : null;
}
async function session(req: IncomingMessage): Promise<Ctx | null> {
  if (config.dryRun) return ctxFor(store, (await store.tenant(DEMO_TENANT))!);
  const t = cookieToken(req); if (!t) return null;
  const tenant = await store.tenantByToken(t); return tenant ? ctxFor(store, tenant) : null;
}

/** Node request handler. Used by the local server and by the Vercel function. */
export async function handler(req: IncomingMessage, res: ServerResponse) {
  await booted;
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    // ---- webhooks, per tenant ----
    if (req.method === 'POST' && p.startsWith('/webhooks/whop/')) {
      const tenant = await store.tenant(p.split('/')[3] ?? '');
      if (!tenant) return json(res, 404, { error: 'unknown tenant' });
      const raw = await readBody(req);
      const secret = tenant.webhook_secret_enc ? decrypt(tenant.webhook_secret_enc) : '';
      if (!verifyWebhook(req.headers as Record<string, string>, raw, secret)) return json(res, 401, { error: 'bad signature' });
      const ctx = ctxFor(store, tenant);
      const evt = JSON.parse(raw);
      if (!(await ctx.shop.markSeen(evt.id))) return json(res, 200, { dup: true });
      let level = 'ignored';
      if (evt.type === 'payment.succeeded' || evt.type === 'payment.failed') {
        const pay = toPayment(evt.data);
        if (evt.type === 'payment.failed') pay.status = 'failed';
        level = (await ingest(ctx, pay))?.level ?? 'unlearned';
      }
      await tick(ctx); // holds fire on traffic too, not only on the cron
      return json(res, 200, { level });
    }

    // ---- cron: fire elapsed holds for every tenant ----
    if (p === '/api/tick') {
      const auth = req.headers.authorization ?? '';
      if (!config.dryRun && (!config.cronSecret || auth !== `Bearer ${config.cronSecret}`)) return json(res, 401, { error: 'nope' });
      let n = 0;
      for (const id of await store.tenantIds()) { const t = await store.tenant(id); if (t) { await tick(ctxFor(store, t)); n++; } }
      return json(res, 200, { ok: true, tenants: n });
    }

    // ---- public pages ----
    if (p === '/' && req.method === 'GET') {
      if (config.dryRun) return html(res, pages.app);
      return (await session(req)) ? redirect(res, '/app') : html(res, pages.landing);
    }
    if (p === '/connect' && req.method === 'GET') return html(res, pages.connect.replace('__PERMISSIONS__', JSON.stringify(REQUIRED_PERMISSIONS)));
    if (p === '/health') return json(res, 200, { ok: true, tenants: (await store.tenantIds()).length, db: config.databaseUrl ? 'postgres' : 'sqlite' });

    // ---- onboarding ----
    if (p === '/api/connect' && req.method === 'POST') {
      if (config.dryRun) return json(res, 400, { error: 'dry run has a demo shop only' });
      const { apiKey, alertUrl } = JSON.parse((await readBody(req)) || '{}');
      const { tenant, ownerToken } = await connect(store, String(apiKey ?? ''), alertUrl ? String(alertUrl) : null);
      res.setHeader('set-cookie', setCookie(ownerToken));
      // Learn synchronously: serverless has no background. Bounded by the function timeout; /api/relearn can resume.
      const status = await learn(store, tenant.id);
      return json(res, 200, { ok: true, tenant: tenant.id, title: tenant.title, learn: status });
    }
    if (p === '/logout') return redirect(res, '/', { 'set-cookie': setCookie('', 0) });

    // ---- signed-in ----
    const ctx = await session(req);
    if (!ctx) return p.startsWith('/api/') ? json(res, 401, { error: 'sign in' }) : redirect(res, '/');
    const { shop } = ctx;

    if (p === '/app') return html(res, pages.app);
    if (p === '/api/state') {
      await tick(ctx);
      return json(res, 200, {
        tenant: { id: ctx.tenant.id, title: ctx.tenant.title, account_id: ctx.tenant.account_id, webhook: !!ctx.tenant.webhook_id },
        learn: await shop.getKV<LearnStatus>('learn'),
        baseline: await shop.getBaseline(), last: await shop.getKV('last_verdict'), scored: (await shop.getKV('scored')) ?? [], incidents: await shop.incidents(20),
        launch_until: (await launchModeActive(ctx)) ? await shop.getKV('launch_until') : null,
        recent: (await shop.paymentsSince(new Date(Date.now() - 3_600_000).toISOString())).slice(-200),
        config: { refundDelayMin: ctx.settings.refundDelayMin, windowMin: ctx.settings.windowMin, immediateRevoke: ctx.settings.immediateRevoke, alertUrl: ctx.settings.alertUrl, dryRun: ctx.dryRun, publicUrl: config.publicUrl },
      });
    }
    if (req.method === 'POST' && p.startsWith('/api/undo/')) return json(res, 200, await undo(ctx, Number(p.split('/').pop())));
    if (p.startsWith('/undo/')) { await undo(ctx, Number(p.split('/').pop())); return redirect(res, '/app'); }
    if (req.method === 'POST' && p === '/api/launch') {
      const { hours } = JSON.parse((await readBody(req)) || '{}');
      await setLaunchMode(ctx, Number(hours ?? 0)); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/settings') {
      const b = JSON.parse((await readBody(req)) || '{}');
      const s = { ...ctx.settings };
      if (b.alertUrl !== undefined) s.alertUrl = b.alertUrl ? String(b.alertUrl).slice(0, 500) : null;
      if (b.refundDelayMin !== undefined) s.refundDelayMin = Math.min(120, Math.max(1, Number(b.refundDelayMin) || 10));
      if (b.immediateRevoke !== undefined) s.immediateRevoke = !!b.immediateRevoke;
      await store.updateTenant(ctx.tenant.id, { settings: s }); return json(res, 200, { ok: true, settings: s });
    }
    if (req.method === 'POST' && p === '/api/relearn') { if (ctx.dryRun) return json(res, 200, { ok: true }); return json(res, 200, { ok: true, learn: await learn(store, ctx.tenant.id) }); }
    if (req.method === 'POST' && p === '/api/disconnect') {
      if (ctx.dryRun) return json(res, 400, { error: 'demo' });
      await disconnect(store, ctx.tenant.id); res.setHeader('set-cookie', setCookie('', 0)); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/simulate' && ctx.dryRun) {
      const { kind, upto } = JSON.parse((await readBody(req)) || '{}');
      if (kind === 'act') { for (const inc of await shop.openIncidents()) await act(ctx, inc); return json(res, 200, { ok: true }); }
      if (kind === 'reset') { resetBurst(); await shop.resetRecent(); await shop.setKV('snooze_until', null); await shop.setKV('last_verdict', null); await shop.setKV('scored', []); return json(res, 200, { ok: true }); }
      const v = await burst(ctx, kind === 'launch' ? 'launch' : kind === 'normal' ? 'normal' : 'attack', typeof upto === 'number' ? upto : undefined);
      return json(res, 200, v);
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e instanceof WhopError ? (e.status === 401 || e.status === 403 ? 400 : e.status) : 500;
    if (status === 500) console.error(e);
    json(res, status, { error: e instanceof WhopError ? friendly(e) : (e as Error).message });
  }
}

function friendly(e: WhopError): string {
  if (e.status === 401) return 'Whop rejected that API key. Check it was copied fully.';
  if (e.status === 403) return 'That key is missing permissions. Create one with the scopes listed on this page.';
  return e.message;
}
