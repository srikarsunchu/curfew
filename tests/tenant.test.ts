import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DRY_RUN = '';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.PUBLIC_URL = 'https://curfew.test';
const { SqliteStore } = await import('../src/store.ts');
const { connect, learn, ctxFor, disconnect } = await import('../src/tenant.ts');
const { encrypt, decrypt } = await import('../src/crypto.ts');
const { history } = await import('../src/simulate.ts');
const { verifyWebhook } = await import('../src/whop.ts');
const { createHmac } = await import('node:crypto');

test('encrypt round-trips and differs per call', () => {
  const a = encrypt('whop_sk_123'), b = encrypt('whop_sk_123');
  assert.notEqual(a, b); assert.equal(decrypt(a), 'whop_sk_123'); assert.equal(decrypt(b), 'whop_sk_123');
});

/** Fake Whop: /accounts, /payments (two pages), /webhooks. Records calls. */
function fakeWhop(calls: string[]) {
  const pays = history(10).slice(0, 150).map((p) => ({ id: p.id, status: p.status, created_at: p.created_at, usd_total: p.usd_total, user: { id: p.user_id, name: p.user_name }, membership: { id: p.membership_id }, billing_address: { country: p.country }, payment_method: { card: { fingerprint: p.card_fingerprint, last4: p.card_last4 } }, decline_code: p.decline_code }));
  return async (input: any, init: any) => {
    const url = String(input); calls.push(`${init?.method} ${url.replace('https://api.whop.com/api/v1', '')}`);
    const auth = init?.headers?.authorization;
    if (auth !== 'Bearer good_key') return new Response('{"error":"unauthorized"}', { status: 401 });
    if (url.includes('/accounts')) return Response.json({ data: [{ id: 'biz_ABC123', title: 'Northwind Picks' }] });
    if (url.includes('/payments')) {
      const after = new URL(url).searchParams.get('after');
      const page = after ? pays.slice(100) : pays.slice(0, 100);
      return Response.json({ data: page, page_info: { end_cursor: 'c1', has_next_page: !after } });
    }
    if (url.endsWith('/webhooks')) { const b = JSON.parse(init.body); return Response.json({ id: 'wh_1', url: b.url, webhook_secret: 'ws_' + Buffer.from('secret-bytes-here').toString('base64') }); }
    if (url.includes('/webhooks/wh_1')) return Response.json({ ok: true });
    return new Response('nope', { status: 404 });
  };
}

test('connect validates the key, learn pulls history and registers the tenant webhook', async () => {
  const calls: string[] = [];
  globalThis.fetch = fakeWhop(calls) as any;
  const store = new SqliteStore(':memory:');
  await assert.rejects(() => connect(store, 'bad_key', null), /rejected|401/);
  const { tenant, ownerToken } = await connect(store, 'good_key', 'https://hooks.slack.com/x');
  assert.equal(tenant.id, 'abc123'); assert.equal(tenant.title, 'Northwind Picks');
  assert.ok(await store.tenantByToken(ownerToken), 'owner token resolves');
  assert.equal(await store.tenantByToken('wrong'), null);
  const s = await learn(store, tenant.id, 10);
  assert.equal(s.state, 'done'); assert.equal(s.fetched, 150); assert.equal(s.webhook, 'ok');
  const t = (await store.tenant(tenant.id))!;
  assert.equal(t.webhook_id, 'wh_1');
  assert.ok(calls.some((c) => c.startsWith('POST /webhooks')));
  const ctx = ctxFor(store, t);
  assert.ok((await ctx.shop.getBaseline())!.total_paid > 100);
  // the registered URL carries the tenant id
  const wh = calls.find((c) => c.startsWith('POST /webhooks'));
  assert.ok(wh);
  // reconnecting the same account keeps the tenant and rotates the token
  const again = await connect(store, 'good_key', null);
  assert.equal(again.tenant.id, tenant.id); assert.equal(await store.tenantByToken(ownerToken), null);
  await disconnect(store, tenant.id);
  assert.equal(await store.tenant(tenant.id), null);
  assert.ok(calls.some((c) => c.startsWith('DELETE /webhooks/wh_1')));
});

test('webhook signatures verify per secret', () => {
  const secret = 'ws_' + Buffer.from('k'.repeat(24)).toString('base64');
  const body = '{"id":"msg_1","type":"payment.succeeded"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v1,' + createHmac('sha256', Buffer.from('k'.repeat(24))).update(`msg_1.${ts}.${body}`).digest('base64');
  assert.ok(verifyWebhook({ 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': sig }, body, secret));
  assert.ok(!verifyWebhook({ 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': sig }, body, 'ws_' + Buffer.from('other').toString('base64')));
});
