import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Payment } from './types.ts';

const BASE = 'https://api.whop.com/api/v1';

export class WhopError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

/** Thin client bound to one account API key. */
export function whop(apiKey: string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new WhopError(res.status, `whop ${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json() as Promise<T>;
  }
  return {
    /** The account this key belongs to. */
    async whoami(): Promise<{ id: string; title: string }> {
      const r = await call<{ data: { id: string; title?: string; name?: string }[] }>('GET', '/accounts?first=1');
      const a = r.data?.[0];
      if (!a) throw new WhopError(404, 'This key does not belong to a business account');
      return { id: a.id, title: a.title ?? a.name ?? a.id };
    },
    async *listPayments(since: Date, accountId?: string): AsyncGenerator<Payment> {
      let after: string | undefined;
      for (;;) {
        const q = new URLSearchParams({ first: '100', direction: 'asc', order: 'created_at', created_after: since.toISOString() });
        if (after) q.set('after', after);
        if (accountId) q.set('account_id', accountId);
        const page = await call<{ data: any[]; page_info: { end_cursor: string; has_next_page: boolean } }>('GET', `/payments?${q}`);
        for (const p of page.data) yield toPayment(p);
        if (!page.page_info?.has_next_page) return;
        after = page.page_info.end_cursor;
      }
    },
    refundPayment: (id: string) => call('POST', `/payments/${id}/refund`, {}),
    revokeMembership: (id: string) => call('POST', `/memberships/${id}/cancel`, { cancellation_mode: 'immediate' }),
    createWebhook: (url: string, accountId?: string) => call<{ id: string; webhook_secret: string; url: string }>('POST', '/webhooks', {
      url, events: EVENTS, api_version: 'v1', enabled: true, ...(accountId ? { resource_id: accountId } : {}),
    }),
    deleteWebhook: (id: string) => call('DELETE', `/webhooks/${id}`).catch(() => null),
  };
}
export type WhopClient = ReturnType<typeof whop>;

export const EVENTS = ['payment.succeeded', 'payment.failed', 'dispute.created', 'refund.created'];

/** Scopes the connect page asks the seller to grant on their API key. */
export const REQUIRED_PERMISSIONS = [
  'payment:basic:read', 'payment:manage', 'payment:dispute:read', 'payment:resolution_center_case:read',
  'membership:cancel', 'member:basic:read', 'member:email:read', 'member:phone:read',
  'plan:basic:read', 'access_pass:basic:read', 'promo_code:basic:read', 'shipment:basic:read',
  'developer:manage_webhook',
];

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

/** Standard Webhooks verification: HMAC-SHA256 over `${id}.${ts}.${body}` with the ws_ secret. */
export function verifyWebhook(headers: Record<string, string | undefined>, rawBody: string, secret: string): boolean {
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
