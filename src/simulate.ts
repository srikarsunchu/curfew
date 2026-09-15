import { learnBaseline } from './baseline.ts';
import { ingest } from './engine.ts';
import type { Ctx } from './tenant.ts';
import type { Payment, Verdict } from './types.ts';

/** Deterministic PRNG so demos replay the same way. */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const FIRST = ['Marcus','Jalen','Priya','Tyler','Sofia','Derek','Hannah','Luis','Aiden','Chloe','Omar','Nate','Kayla','Brandon','Isabella','Jordan','Ethan','Maya','Connor','Leah','Diego','Trevor','Ava','Malik','Grace','Cody','Nina','Ryan','Zoe','Kyle'];
const LAST = ['Reed','Okafor','Patel','Brooks','Alvarez','Nguyen','Kim','Carter','Moore','Silva','Hayes','Foster','Bennett','Ortiz','Walsh','Cruz','Price','Ward','Cole','Ross'];
const person = (r: () => number) => `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
const junk = (r: () => number) => { let t = ''; for (let i = 0; i < 7; i++) t += 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(r() * 31)]; return `${t}@${['proton.me', 'gmail.com', 'outlook.com', 'mail.ru'][Math.floor(r() * 4)]}`; };
const last4 = (fp: string) => { let h = 0; for (const c of fp) h = (h * 31 + c.charCodeAt(0)) >>> 0; return String(1000 + (h % 9000)); };
const COUNTRIES = ['US', 'US', 'US', 'US', 'GB', 'CA', 'AU', 'DE'];
const FAR = ['NG', 'VN', 'BR', 'ID', 'PK', 'RU', 'TR', 'UA', 'PH', 'BD', 'EG', 'MA'];

/** 60 days of a healthy digital-goods shop: ~20 paid/day, mostly repeat buyers, $49 avg. */
export function history(days = 60, seed = 1): Payment[] {
  const r = rng(seed);
  const out: Payment[] = [];
  const users = Array.from({ length: 400 }, (_, i) => `user_${i}`);
  const names = new Map(users.map((u) => [u, person(r)]));
  const cards = new Map(users.map((u) => [u, `fp_${u}`]));
  const start = Date.now() - days * 86_400_000;
  for (let d = 0; d < days; d++) {
    const n = 14 + Math.floor(r() * 12);
    for (let i = 0; i < n; i++) {
      const hour = 9 + Math.floor(r() * 12); // daytime skew
      const t = start + d * 86_400_000 + hour * 3_600_000 + r() * 3_600_000;
      const isNew = r() < 0.25;
      const u = isNew ? `user_new_${d}_${i}` : users[Math.floor(r() * users.length)]!;
      if (!cards.has(u)) { cards.set(u, `fp_${u}`); names.set(u, person(r)); }
      const failed = r() < 0.04;
      out.push(mk(`pay_h_${d}_${i}`, t, { user: u, name: names.get(u)!, fp: cards.get(u)!, country: COUNTRIES[Math.floor(r() * COUNTRIES.length)]!, usd: r() < 0.7 ? 49 : 99, failed }));
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function mk(id: string, t: number, o: { user: string; name: string; fp: string; country: string; usd: number; failed?: boolean }): Payment {
  return {
    id, status: o.failed ? 'failed' : 'paid', created_at: new Date(t).toISOString(), usd_total: o.failed ? 0 : o.usd,
    user_id: o.user, user_name: o.name, member_id: `mbr_${o.user}`, membership_id: o.failed ? null : `mem_${id}`, country: o.country,
    card_fingerprint: o.fp, card_last4: last4(o.fp), decline_code: o.failed ? 'do_not_honor' : null, refunded_at: null,
  };
}

/** Card-testing burst: 80 attempts in 8 minutes, fresh accounts, far-flung countries, cards cycling, half declined. */
export function attackBurst(now = Date.now(), seed = 7): Payment[] {
  const r = rng(seed);
  const out: Payment[] = [];
  const stolen = Array.from({ length: 12 }, (_, i) => `fp_stolen_${i}`);
  const bots = new Map<string, string>();
  for (let i = 0; i < 80; i++) {
    const t = now - 8 * 60_000 + i * 6_000;
    const u = `user_bot_${Math.floor(i / 3)}`; // each bot account cycles a few cards
    if (!bots.has(u)) bots.set(u, junk(r));
    out.push(mk(`pay_atk_${now}_${i}`, t, { user: u, name: bots.get(u)!, fp: stolen[Math.floor(r() * stolen.length)]!, country: FAR[Math.floor(r() * FAR.length)]!, usd: 49, failed: r() < 0.5 }));
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
    out.push(mk(`pay_lch_${now}_${i}`, t, { user: u, name: person(r), fp: `fp_${u}`, country: COUNTRIES[Math.floor(r() * COUNTRIES.length)]!, usd: r() < 0.7 ? 49 : 99, failed: r() < 0.04 }));
  }
  return out;
}

/** Seed a shop with synthetic history and a learned baseline. */
export async function seed(ctx: Ctx) {
  for (const p of history()) await ctx.shop.upsertPayment(p);
  await ctx.shop.setBaseline(learnBaseline(await ctx.shop.allPayments(), ctx.settings.windowMin, 60));
}

let pending: Payment[] = [];
let cursor = 0;

/** Ingest a whole burst, or with `upto` only the first N payments of a burst prepared once (for stepped demos). */
export async function burst(ctx: Ctx, kind: 'attack' | 'launch' | 'normal', upto?: number): Promise<Verdict | null> {
  if (!(await ctx.shop.getBaseline())) await seed(ctx);
  if (kind === 'normal') {
    // two ordinary repeat customers in the last few minutes
    const r = rng(3);
    const ps = [0, 1].map((i) => mk(`pay_ok_${Date.now()}_${i}`, Date.now() - (6 - i * 3) * 60_000, { user: `user_${10 + i}`, name: person(r), fp: `fp_user_${10 + i}`, country: 'US', usd: i ? 99 : 49 }));
    let v: Verdict | null = null;
    for (const p of ps) v = await ingest(ctx, p);
    return v;
  }
  if (upto === undefined) {
    const ps = kind === 'attack' ? attackBurst() : launchBurst();
    let v: Verdict | null = null;
    for (const p of ps) v = await ingest(ctx, p);
    return v;
  }
  if (!pending.length || cursor > upto) { pending = kind === 'attack' ? attackBurst() : launchBurst(); cursor = 0; }
  let v: Verdict | null = null;
  for (; cursor < Math.min(upto, pending.length); cursor++) v = await ingest(ctx, pending[cursor]!);
  return v ?? (await import('./engine.ts')).evaluate(ctx);
}
export function resetBurst() { pending = []; cursor = 0; }

// `node src/simulate.ts` : print what the detector says about each scenario, no server needed.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  process.env.DRY_RUN = '1';
  const { detect } = await import('./detector.ts');
  const { demoCtx } = await import('./demo.ts');
  for (const kind of ['attack', 'launch'] as const) {
    const ctx = await demoCtx(':memory:');
    await seed(ctx);
    const ps = kind === 'attack' ? attackBurst() : launchBurst();
    for (const p of ps) await ctx.shop.upsertPayment(p);
    const v = detect({ baseline: (await ctx.shop.getBaseline())!, window: ps, firstSeen: await ctx.shop.firstSeen() });
    console.log(`\n${kind.toUpperCase()} -> ${v.level} (${v.score}/6), ${v.suspects.length} suspects`);
    for (const s of v.signals) console.log(`  ${s.fired ? '🔴' : '⚪'} ${s.name.padEnd(12)} ${s.note}`);
  }
}
