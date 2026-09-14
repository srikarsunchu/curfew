import type { Baseline, Payment } from './types.ts';

function meanSd(xs: number[]) {
  if (xs.length === 0) return { mean: 0, sd: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, sd };
}

/**
 * Learn "normal" from history. No ML: per-hour-of-day bucket counts, new-buyer share,
 * decline share, spend distribution, and how many countries a busy window usually spans.
 * Everything here is explainable in an alert, which matters more than accuracy.
 */
export function learnBaseline(payments: Payment[], windowMin: number, days: number): Baseline {
  const paid = payments.filter((p) => p.status === 'paid');
  const failed = payments.filter((p) => p.status === 'failed' || p.decline_code);
  const bucketMs = windowMin * 60_000;

  // Count paid payments per window bucket, grouped by hour of day. Include empty buckets
  // so a quiet business gets a low mean rather than a mean over busy buckets only.
  const perHour: number[][] = Array.from({ length: 24 }, () => []);
  if (paid.length) {
    const start = Math.floor(new Date(paid[0]!.created_at).getTime() / bucketMs) * bucketMs;
    const end = Date.now();
    const counts = new Map<number, number>();
    for (const p of paid) {
      const b = Math.floor(new Date(p.created_at).getTime() / bucketMs) * bucketMs;
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    for (let b = start; b <= end; b += bucketMs) perHour[new Date(b).getUTCHours()]!.push(counts.get(b) ?? 0);
  }
  const rate_by_hour = perHour.map(meanSd);

  // New-buyer share: a buyer is new on their first paid payment.
  const seen = new Set<string>();
  let firsts = 0;
  for (const p of paid) {
    const k = p.user_id ?? p.id;
    if (!seen.has(k)) { seen.add(k); firsts++; }
  }
  const new_buyer_share = paid.length ? firsts / paid.length : 0;

  const usd = meanSd(paid.map((p) => p.usd_total));

  // Where the business normally sells. Unfamiliar countries in a burst is the geo signal.
  const country_share: Record<string, number> = {};
  for (const p of paid) if (p.country) country_share[p.country] = (country_share[p.country] ?? 0) + 1 / paid.length;
  const overall_rate = paid.length ? paid.length / Math.max(1, (Date.now() - +new Date(paid[0]!.created_at)) / bucketMs) : 0;

  return {
    learned_at: new Date().toISOString(), days,
    rate_by_hour, new_buyer_share,
    decline_share: paid.length + failed.length ? failed.length / (paid.length + failed.length) : 0,
    avg_usd: usd.mean, sd_usd: usd.sd,
    country_share, overall_rate, total_paid: paid.length,
  };
}
