import { config } from './config.ts';
import { detect } from './detector.ts';
import { respond } from './responder.ts';
import type { Store } from './store.ts';
import type { Payment, Verdict } from './types.ts';

/** Ingest one payment (from a webhook or the simulator) and re-evaluate the window. */
export async function ingest(store: Store, p: Payment, now = new Date()) {
  store.upsertPayment(p);
  return evaluate(store, now);
}

export async function evaluate(store: Store, now = new Date()): Promise<Verdict | null> {
  const baseline = store.baseline;
  if (!baseline) return null;
  const since = new Date(now.getTime() - config.windowMin * 60_000).toISOString();
  const window = store.paymentsSince(since).filter((p) => p.created_at <= now.toISOString());
  const verdict = detect({ baseline, window, firstSeen: store.firstSeen(), now });
  store.setKV('last_verdict', { at: now.toISOString(), level: verdict.level, score: verdict.score, signals: verdict.signals, paid: window.filter((p) => p.status === 'paid').length });
  await respond(store, verdict);
  return verdict;
}
