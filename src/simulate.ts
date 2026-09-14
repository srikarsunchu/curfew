import { learnBaseline } from './baseline.ts';
import { ingest } from './engine.ts';
import { Store } from './store.ts';
import type { Payment, Verdict } from './types.ts';

/** Deterministic PRNG so demos replay the same way. */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const COUNTRIES = ['US', 'US', 'US', 'US', 'GB', 'CA', 'AU', 'DE'];
const FAR = ['NG', 'VN', 'BR', 'ID', 'PK', 'RU', 'TR', 'UA', 'PH', 'BD', 'EG', 'MA'];

/** 60 days of a healthy digital-goods shop: ~20 paid/day, mostly repeat buyers, $49 avg. */
export function history(days = 60, seed = 1): Payment[] {
  const r = rng(seed);
  const out: Payment[] = [];
  const users = Array.from({ length: 400 }, (_, i) => `user_${i}`);
  const cards = new Map(users.map((u) => [u, `fp_${u}`]));
  const start = Date.now() - days * 86_400_000;
  for (let d = 0; d < days; d++) {
    const n = 14 + Math.floor(r() * 12);
    for (let i = 0; i < n; i++) {
      const hour = 9 + Math.floor(r() * 12); // daytime skew
      const t = start + d * 86_400_000 + hour * 3_600_000 + r() * 3_600_000;
      const isNew = r() < 0.25;
      const u = isNew ? `user_new_${d}_${i}` : users[Math.floor(r() * users.length)]!;
      if (!cards.has(u)) cards.set(u, `fp_${u}`);
      const failed = r() < 0.04;
      out.push(mk(`pay_h_${d}_${i}`, t, { user: u, fp: cards.get(u)!, country: COUNTRIES[Math.floor(r() * COUNTRIES.length)]!, usd: r() < 0.7 ? 49 : 99, failed }));
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function mk(id: string, t: number, o: { user: string; fp: string; country: string; usd: number; failed?: boolean }): Payment {
  return {
    id, status: o.failed ? 'failed' : 'paid', created_at: new Date(t).toISOString(), usd_total: o.failed ? 0 : o.usd,
    user_id: o.user, member_id: `mbr_${o.user}`, membership_id: o.failed ? null : `mem_${id}`, country: o.country,
    card_fingerprint: o.fp, card_last4: o.fp.slice(-4), decline_code: o.failed ? 'do_not_honor' : null, refunded_at: null,
  };
}

/** Card-testing burst: 80 attempts in 8 minutes, fresh accounts, far-flung countries, cards cycling, half declined. */
export function attackBurst(now = Date.now(), seed = 7): Payment[] {
  const r = rng(seed);
  const out: Payment[] = [];
  const stolen = Array.from({ length: 12 }, (_, i) => `fp_stolen_${i}`);
  for (let i = 0; i < 80; i++) {
    const t = now - 8 * 60_000 + i * 6_000;
    const u = `user_bot_${Math.floor(i / 3)}`; // each bot account cycles a few cards
    out.push(mk(`pay_atk_${now}_${i}`, t, { user: u, fp: stolen[Math.floor(r() * stolen.length)]!, country: FAR[Math.floor(r() * FAR.length)]!, usd: 49, failed: r() < 0.5 }));
  }
  return out;
}

/** A real launch: 80 orders in 10 minutes from new buyers, but normal countries, unique cards, few declines. */
export function launchBurst(now = Date.now(), seed = 9): Payment[] {
  const r = rng(seed);
  const out: Payment[] = [];
  for (let i = 0; i < 80; i++) {
    const t = now - 10 * 60_000 + i * 7_500;
    const u = `user_launch_${now}_${i}`;
    out.push(mk(`pay_lch_${now}_${i}`, t, { user: u, fp: `fp_${u}`, country: COUNTRIES[Math.floor(r() * COUNTRIES.length)]!, usd: r() < 0.7 ? 49 : 99, failed: r() < 0.04 }));
  }
  return out;
}

/** Seed a store with synthetic history and a learned baseline. */
export function seed(store: Store, windowMin = 10) {
  for (const p of history()) store.upsertPayment(p);
  store.baseline = learnBaseline(store.allPayments(), windowMin, 60);
}

export async function burst(store: Store, kind: 'attack' | 'launch'): Promise<Verdict | null> {
  if (!store.baseline) seed(store);
  const ps = kind === 'attack' ? attackBurst() : launchBurst();
  let v: Verdict | null = null;
  for (const p of ps) v = await ingest(store, p);
  return v;
}

// `node src/simulate.ts` : print what the detector says about each scenario, no server needed.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  process.env.DRY_RUN = '1';
  const { detect } = await import('./detector.ts');
  for (const kind of ['attack', 'launch'] as const) {
    const store = new Store(':memory:');
    seed(store);
    const ps = kind === 'attack' ? attackBurst() : launchBurst();
    for (const p of ps) store.upsertPayment(p);
    const v = detect({ baseline: store.baseline!, window: ps, firstSeen: store.firstSeen() });
    console.log(`\n${kind.toUpperCase()} -> ${v.level} (${v.score}/6), ${v.suspects.length} suspects`);
    for (const s of v.signals) console.log(`  ${s.fired ? '🔴' : '⚪'} ${s.name.padEnd(12)} ${s.note}`);
  }
}
