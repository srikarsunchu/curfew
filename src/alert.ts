import { config } from './config.ts';
import type { Store } from './store.ts';
import type { Incident, Verdict } from './types.ts';

/** Posts to any incoming-webhook URL. Slack and Discord both accept {text}/{content}. */
export async function sendAlert(store: Store, inc: Incident, verdict: Verdict | null, headline: string) {
  const fired = inc.signals.filter((s) => s.fired).map((s) => `• ${s.name}: ${s.note}`).join('\n');
  const text = [
    `🚨 curfew ${inc.level.toUpperCase()} #${inc.id} — ${headline}`,
    fired,
    verdict ? `${verdict.suspects.length} suspect payments, $${verdict.suspects.reduce((a, p) => a + p.usd_total, 0).toFixed(0)}` : '',
    `dashboard: ${config.publicUrl}/   undo: ${config.publicUrl}/undo/${inc.id}`,
  ].filter(Boolean).join('\n');
  console.log(text);
  if (!config.alertUrl) return;
  try {
    await fetch(config.alertUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
  } catch (e) { console.error('alert failed', (e as Error).message); }
}
