import { config } from './config.ts';
import { Store } from './store.ts';
import { learnBaseline } from './baseline.ts';
import { createWebhook, listPayments } from './whop.ts';

const cmd = process.argv[2];
const store = new Store();

if (cmd === 'learn') {
  const days = Number(process.argv[3] ?? 60);
  const since = new Date(Date.now() - days * 86_400_000);
  let n = 0;
  for await (const p of listPayments(since)) { store.upsertPayment(p); n++; if (n % 100 === 0) console.log(`  ${n} payments...`); }
  const b = learnBaseline(store.allPayments(), config.windowMin, days);
  store.baseline = b;
  console.log(`learned from ${n} payments over ${days}d`);
  console.log(`  paid: ${b.total_paid}  new-buyer share: ${(b.new_buyer_share * 100).toFixed(0)}%  decline share: ${(b.decline_share * 100).toFixed(0)}%`);
  console.log(`  avg $${b.avg_usd.toFixed(2)} ± ${b.sd_usd.toFixed(2)}  top countries: ${Object.entries(b.country_share).sort((a, z) => z[1] - a[1]).slice(0, 4).map(([c, v]) => `${c} ${(v * 100).toFixed(0)}%`).join(', ')}`);
  const busiest = b.rate_by_hour.map((h, i) => ({ i, ...h })).sort((a, z) => z.mean - a.mean)[0]!;
  console.log(`  busiest hour ${busiest.i}:00 UTC, ${busiest.mean.toFixed(2)} paid per ${config.windowMin}m`);
} else if (cmd === 'register') {
  const w = await createWebhook(`${config.publicUrl}/webhooks/whop`);
  console.log(`webhook ${w.id} -> ${w.url}`);
  console.log(`\nadd to .env:\nWHOP_WEBHOOK_SECRET=${w.webhook_secret}`);
} else {
  console.log('usage: cli.ts learn [days] | register');
}
