import { detect, scorePayments } from './detector.ts';
import { respond } from './responder.ts';
import type { Ctx } from './tenant.ts';
import type { Payment, Verdict } from './types.ts';

/** Ingest one payment (from a webhook or the simulator) and re-evaluate the window. */
export async function ingest(ctx: Ctx, p: Payment, now = new Date()) {
  await ctx.shop.upsertPayment(p);
  return evaluate(ctx, now);
}

export async function evaluate(ctx: Ctx, now = new Date()): Promise<Verdict | null> {
  const { shop } = ctx;
  const baseline = await shop.getBaseline();
  if (!baseline) return null;
  const since = new Date(now.getTime() - ctx.settings.windowMin * 60_000).toISOString();
  const window = (await shop.paymentsSince(since)).filter((p) => p.created_at <= now.toISOString());
  const firstSeen = await shop.firstSeen();
  const verdict = detect({ baseline, window, firstSeen, now });
  await shop.setKV('scored', scorePayments(window, baseline, firstSeen, verdict).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 60));
  await shop.setKV('last_verdict', { at: now.toISOString(), level: verdict.level, score: verdict.score, signals: verdict.signals, paid: window.filter((p) => p.status === 'paid').length });
  await respond(ctx, verdict);
  return verdict;
}
