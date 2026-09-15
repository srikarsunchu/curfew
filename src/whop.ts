import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import type { Payment } from './types.ts';

const BASE = 'https://api.whop.com/api/v1';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`whop ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Flatten Whop's payment object to the slice we store. Works for list items and webhook data. */
export function toPayment(p: any): Payment {
  return {
    id: p.id,
    status: p.status,
    created_at: p.created_at ?? p.paid_at ?? new Date().toISOString(),
    usd_total: Number(p.usd_total ?? p.total ?? 0),
    user_id: p.user?.id ?? null,
    user_name: p.user?.name ?? p.user?.email ?? p.user?.username ?? null,
    member_id: p.member?.id ?? null,
    membership_id: p.membership?.id ?? null,
    country: p.billing_address?.country ?? null,
    card_fingerprint: p.payment_method?.card?.fingerprint ?? null,
    card_last4: p.card_last4 ?? p.payment_method?.card?.last4 ?? null,
    decline_code: p.decline_code ?? null,
    refunded_at: p.refunded_at ?? null,
  };
}

/** Pages through every payment created after `since`, oldest first. */
export async function* listPayments(since: Date): AsyncGenerator<Payment> {
  let after: string | undefined;
  for (;;) {
    const q = new URLSearchParams({ first: '100', direction: 'asc', order: 'created_at', created_after: since.toISOString() });
    if (after) q.set('after', after);
    if (config.accountId) q.set('account_id', config.accountId);
    const page = await call<{ data: any[]; page_info: { end_cursor: string; has_next_page: boolean } }>('GET', `/payments?${q}`);
    for (const p of page.data) yield toPayment(p);
    if (!page.page_info.has_next_page) return;
    after = page.page_info.end_cursor;
  }
}

export async function refundPayment(id: string) {
  if (config.dryRun) return { id, dry: true };
  return call('POST', `/payments/${id}/refund`, {});
}

export async function revokeMembership(id: string) {
  if (config.dryRun) return { id, dry: true };
  return call('POST', `/memberships/${id}/cancel`, { cancellation_mode: 'immediate' });
}

export const EVENTS = ['payment.succeeded', 'payment.failed', 'dispute.created', 'refund.created'];

export async function createWebhook(url: string) {
  return call<{ id: string; webhook_secret: string; url: string }>('POST', '/webhooks', {
    url, events: EVENTS, api_version: 'v1', enabled: true,
    ...(config.accountId ? { resource_id: config.accountId } : {}),
  });
}

/** Standard Webhooks verification: HMAC-SHA256 over `${id}.${ts}.${body}` with the ws_ secret. */
export function verifyWebhook(headers: Record<string, string | undefined>, rawBody: string, secret = config.webhookSecret): boolean {
  const id = headers['webhook-id'], ts = headers['webhook-timestamp'], sig = headers['webhook-signature'];
  if (!id || !ts || !sig || !secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = secret.startsWith('ws_') ? secret.slice(3) : secret;
  const expected = createHmac('sha256', Buffer.from(key, 'base64')).update(`${id}.${ts}.${rawBody}`).digest();
  return sig.split(' ').some((part) => {
    const [, v] = part.split(',');
    if (!v) return false;
    const got = Buffer.from(v, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
