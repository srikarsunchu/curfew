import type { Baseline, Payment, Signal, Verdict } from './types.ts';

export type DetectorInput = {
  baseline: Baseline;
  /** All payments (paid + failed) whose created_at falls in the rolling window. */
  window: Payment[];
  /** user_id -> first-ever payment timestamp, from full history. */
  firstSeen: Map<string, string>;
  now?: Date;
};

/**
 * Six cheap signals. Attack = 3+ fire together, elevated = 2. A single signal never acts,
 * which is what keeps a real launch (rate spike + new buyers) from tripping on its own:
 * a real launch has your usual countries, usual card diversity, and few declines.
 */
export function detect({ baseline, window, firstSeen, now = new Date() }: DetectorInput): Verdict {
  const paid = window.filter((p) => p.status === 'paid');
  const failed = window.filter((p) => p.status === 'failed' || p.decline_code);
  const signals: Signal[] = [];

  // 1. Velocity: paid count vs this hour's baseline (z-score, floor on sd so quiet shops still fire).
  const hourly = baseline.rate_by_hour[now.getUTCHours()] ?? { mean: 0, sd: 0 };
  // Never let a quiet hour make "usual" read as zero: floor at half the all-hours rate.
  const hb = { mean: Math.max(hourly.mean, baseline.overall_rate * 0.5), sd: hourly.sd };
  const sd = Math.max(hb.sd, 1);
  const z = (paid.length - hb.mean) / sd;
  signals.push({ name: 'velocity', value: round(z), threshold: 4, fired: z > 4 && paid.length >= 5,
    note: `${paid.length} paid in window vs usual ${hb.mean < 1 ? hb.mean.toFixed(1) : round(hb.mean)}` });

  // 2. New buyers: share of paid payments from users with no earlier history.
  const windowStart = Math.min(...window.map((p) => +new Date(p.created_at)), +now);
  const isNew = (p: Payment) => {
    if (!p.user_id) return true;
    const first = firstSeen.get(p.user_id);
    return !first || +new Date(first) >= windowStart;
  };
  const newShare = paid.length ? paid.filter(isNew).length / paid.length : 0;
  const newThresh = Math.min(0.95, Math.max(0.6, baseline.new_buyer_share + 0.3));
  signals.push({ name: 'new_buyers', value: round(newShare), threshold: round(newThresh), fired: paid.length >= 5 && newShare > newThresh,
    note: `${pct(newShare)} first-time buyers vs usual ${pct(baseline.new_buyer_share)}` });

  // 3. Declines: failed share in window vs baseline. Card testing shows up here first.
  const declShare = paid.length + failed.length ? failed.length / (paid.length + failed.length) : 0;
  const declThresh = Math.min(0.9, Math.max(0.3, baseline.decline_share * 3 + 0.1));
  signals.push({ name: 'declines', value: round(declShare), threshold: round(declThresh), fired: failed.length >= 5 && declShare > declThresh,
    note: `${failed.length} declines, ${pct(declShare)} of attempts vs usual ${pct(baseline.decline_share)}` });

  // 4. Geography: share of paid payments from countries this business rarely or never sells to.
  const unfamiliar = paid.filter((p) => p.country && (baseline.country_share[p.country] ?? 0) < 0.02);
  const geoShare = paid.length ? unfamiliar.length / paid.length : 0;
  signals.push({ name: 'geo_spread', value: round(geoShare), threshold: 0.4, fired: paid.length >= 5 && geoShare > 0.4,
    note: `${pct(geoShare)} from countries you rarely sell to (${[...new Set(unfamiliar.map((p) => p.country))].slice(0, 6).join(', ') || 'none'})` });

  // 5. Card reuse: one fingerprint across several users, or many cards per user. Both scream bot.
  const byFp = new Map<string, Set<string>>();
  const byUser = new Map<string, Set<string>>();
  for (const p of window) {
    if (p.card_fingerprint) {
      if (!byFp.has(p.card_fingerprint)) byFp.set(p.card_fingerprint, new Set());
      byFp.get(p.card_fingerprint)!.add(p.user_id ?? p.id);
    }
    if (p.user_id && p.card_fingerprint) {
      if (!byUser.has(p.user_id)) byUser.set(p.user_id, new Set());
      byUser.get(p.user_id)!.add(p.card_fingerprint);
    }
  }
  const sharedCards = [...byFp.values()].filter((s) => s.size >= 3).length;
  const cardHoppers = [...byUser.values()].filter((s) => s.size >= 3).length;
  const reuse = sharedCards + cardHoppers;
  signals.push({ name: 'card_reuse', value: reuse, threshold: 1, fired: reuse >= 1,
    note: `${sharedCards} cards used by 3+ accounts, ${cardHoppers} accounts cycling 3+ cards` });

  // 6. Spend: window average far from baseline (bots pick the cheapest plan, or max it out).
  const avg = paid.length ? paid.reduce((a, p) => a + p.usd_total, 0) / paid.length : baseline.avg_usd;
  const spendZ = baseline.sd_usd > 0 ? Math.abs(avg - baseline.avg_usd) / baseline.sd_usd : 0;
  signals.push({ name: 'spend_shift', value: round(spendZ), threshold: 2.5, fired: paid.length >= 5 && spendZ > 2.5,
    note: `avg $${round(avg)} vs usual $${round(baseline.avg_usd)}` });

  const score = signals.filter((s) => s.fired).length;
  const level = score >= 3 ? 'attack' : score === 2 ? 'elevated' : 'normal';

  // Suspects: in an attack, act on new buyers in the window, plus anyone tied to a reused card.
  const flaggedFps = new Set([...byFp.entries()].filter(([, s]) => s.size >= 3).map(([fp]) => fp));
  const hopperUsers = new Set([...byUser.entries()].filter(([, s]) => s.size >= 3).map(([u]) => u));
  const suspects = level === 'attack'
    ? paid.filter((p) => isNew(p) || (p.card_fingerprint && flaggedFps.has(p.card_fingerprint)) || (p.user_id && hopperUsers.has(p.user_id)))
    : [];

  return { level, score, signals, window: paid, suspects };
}

const round = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Per-payment risk score, 0-99, Radar-style. Each factor is a plain sentence so the row can
 * explain itself. Factors are additive; the window verdict supplies the context factors
 * (velocity, decline burst) that a single payment cannot know about on its own.
 */
export type Scored = Payment & { risk: number; insights: string[] };

export function scorePayments(window: Payment[], baseline: Baseline, firstSeen: Map<string, string>, verdict: Verdict): Scored[] {
  const byFp = new Map<string, Set<string>>();
  const byUser = new Map<string, Set<string>>();
  const failsByUser = new Map<string, number>();
  for (const p of window) {
    if (p.card_fingerprint) { (byFp.get(p.card_fingerprint) ?? byFp.set(p.card_fingerprint, new Set()).get(p.card_fingerprint)!).add(p.user_id ?? p.id); }
    if (p.user_id && p.card_fingerprint) { (byUser.get(p.user_id) ?? byUser.set(p.user_id, new Set()).get(p.user_id)!).add(p.card_fingerprint); }
    if (p.user_id && (p.status === 'failed' || p.decline_code)) failsByUser.set(p.user_id, (failsByUser.get(p.user_id) ?? 0) + 1);
  }
  const fired = new Set(verdict.signals.filter((s) => s.fired).map((s) => s.name));
  const windowStart = Math.min(...window.map((p) => +new Date(p.created_at)));
  return window.map((p) => {
    const f: [number, string][] = [];
    const first = p.user_id ? firstSeen.get(p.user_id) : undefined;
    if (!p.user_id || !first || +new Date(first) >= windowStart) f.push([14, 'First purchase from this account']);
    else f.push([0, `Customer since ${first.slice(0, 10)}`]);
    const share = p.country ? baseline.country_share[p.country] ?? 0 : 0;
    if (p.country && share < 0.02) f.push([18, `Unusual country ${p.country}, ${(share * 100).toFixed(1)}% of your sales`]);
    const sharers = p.card_fingerprint ? byFp.get(p.card_fingerprint)!.size : 1;
    if (sharers >= 3) f.push([30, `Card shared by ${sharers} accounts`]);
    const cards = p.user_id ? byUser.get(p.user_id)?.size ?? 1 : 1;
    if (cards >= 3) f.push([22, `Account tried ${cards} different cards`]);
    const fails = p.user_id ? failsByUser.get(p.user_id) ?? 0 : 0;
    if (fails >= 2) f.push([12, `${fails} declined attempts from this account`]);
    if (p.status === 'failed' || p.decline_code) f.push([6, `Declined: ${p.decline_code ?? 'unknown'}`]);
    if (fired.has('velocity')) f.push([8, 'Arrived during a volume spike']);
    if (fired.has('declines')) f.push([8, 'Arrived during a decline burst']);
    f.sort((a, b) => b[0] - a[0]);
    const risk = Math.min(99, 4 + f.reduce((a, [w]) => a + w, 0));
    const insights = f.map(([, t]) => t);
    return { ...p, risk: Math.min(99, risk), insights };
  });
}
