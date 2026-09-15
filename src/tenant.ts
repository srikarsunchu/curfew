import { config, DEMO_TENANT, type Settings } from './config.ts';
import { decrypt, encrypt, token } from './crypto.ts';
import type { Shop, Store, Tenant } from './store.ts';
import { whop, WhopError, type WhopClient } from './whop.ts';
import { learnBaseline } from './baseline.ts';
import type { Baseline } from './types.ts';

/** Everything the engine needs for one shop: its data view, its Whop client, its settings. */
export type Ctx = { shop: Shop; whop: WhopClient | null; settings: Settings; tenant: Tenant; dryRun: boolean };

export function ctxFor(store: Store, t: Tenant): Ctx {
  const dry = config.dryRun && t.id === DEMO_TENANT;
  return { shop: store.shop(t.id), whop: t.api_key_enc && !dry ? whop(decrypt(t.api_key_enc)) : null, settings: t.settings, tenant: t, dryRun: dry };
}

export const defaultSettings = (): Settings => ({ refundDelayMin: config.defaults.refundDelayMin, immediateRevoke: config.defaults.immediateRevoke, windowMin: config.defaults.windowMin, alertUrl: null });

/** Validate the key against Whop, create the tenant, return the owner token (shown once, then only its hash is kept). */
export async function connect(store: Store, apiKey: string, alertUrl: string | null): Promise<{ tenant: Tenant; ownerToken: string }> {
  apiKey = apiKey.trim();
  if (!apiKey) throw new WhopError(400, 'Paste your Whop API key');
  const client = whop(apiKey);
  const me = await client.whoami();
  const existing = await store.tenantByAccount(me.id);
  const ownerToken = token();
  if (existing) {
    // Reconnect: new key, new owner token; keep history and baseline.
    await store.updateTenant(existing.id, { api_key_enc: encrypt(apiKey), title: me.title, settings: { ...existing.settings, alertUrl } });
    await store.rotateOwnerToken(existing.id, ownerToken);
    return { tenant: (await store.tenant(existing.id))!, ownerToken };
  }
  const id = me.id.replace(/^biz_/, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || token(6);
  const tenant = await store.createTenant({ id, title: me.title, account_id: me.id, api_key_enc: encrypt(apiKey), settings: { ...defaultSettings(), alertUrl }, ownerToken });
  return { tenant, ownerToken };
}

export type LearnStatus = { state: 'idle' | 'running' | 'done' | 'error'; fetched: number; started_at?: string; finished_at?: string; error?: string; webhook?: 'pending' | 'ok' | 'error'; webhook_error?: string };

/** Pull history, build the baseline, then register the webhook. Runs in-process; progress lives in kv. */
export async function learn(store: Store, tenantId: string, days = config.defaults.learnDays): Promise<LearnStatus> {
  const t = await store.tenant(tenantId); if (!t) throw new Error('no tenant');
  const ctx = ctxFor(store, t);
  const status: LearnStatus = { state: 'running', fetched: 0, started_at: new Date().toISOString(), webhook: t.webhook_id ? 'ok' : 'pending' };
  await ctx.shop.setKV('learn', status);
  try {
    if (ctx.whop) {
      const since = new Date(Date.now() - days * 86_400_000);
      for await (const p of ctx.whop.listPayments(since, t.account_id ?? undefined)) {
        await ctx.shop.upsertPayment(p); status.fetched++;
        if (status.fetched % 100 === 0) await ctx.shop.setKV('learn', status);
      }
    }
    const b: Baseline = learnBaseline(await ctx.shop.allPayments(), ctx.settings.windowMin, days);
    await ctx.shop.setBaseline(b);
    if (ctx.whop && !t.webhook_id) {
      try {
        const w = await ctx.whop.createWebhook(`${config.publicUrl}/webhooks/whop/${t.id}`, t.account_id ?? undefined);
        await store.updateTenant(t.id, { webhook_id: w.id, webhook_secret_enc: encrypt(w.webhook_secret) });
        status.webhook = 'ok';
      } catch (e) { status.webhook = 'error'; status.webhook_error = (e as Error).message; }
    }
    status.state = 'done'; status.finished_at = new Date().toISOString();
  } catch (e) {
    status.state = 'error'; status.error = (e as Error).message; status.finished_at = new Date().toISOString();
  }
  await ctx.shop.setKV('learn', status);
  return status;
}

/** Remove the webhook on Whop's side and every row we hold. */
export async function disconnect(store: Store, tenantId: string) {
  const t = await store.tenant(tenantId); if (!t) return;
  const ctx = ctxFor(store, t);
  if (ctx.whop && t.webhook_id) await ctx.whop.deleteWebhook(t.webhook_id);
  await store.deleteTenant(tenantId);
}
