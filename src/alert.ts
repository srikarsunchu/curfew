import { config } from './config.ts';
import type { Ctx } from './tenant.ts';
import type { Incident, Verdict } from './types.ts';

/** Posts to any incoming-webhook URL. Slack and Discord both accept {text}/{content}. */
export async function sendAlert(ctx: Ctx, inc: Incident, verdict: Verdict | null, headline: string) {
  const fired = inc.signals.filter((s) => s.fired).map((s) => `• ${s.name}: ${s.note}`).join('\n');
  const text = [
    `🚨 curfew ${inc.level.toUpperCase()} #${inc.id} — ${ctx.tenant.title} — ${headline}`,
    fired,
    verdict ? `${verdict.suspects.length} suspect payments, $${verdict.suspects.reduce((a, p) => a + p.usd_total, 0).toFixed(0)}` : '',
    `dashboard: ${config.publicUrl}/app   undo: ${config.publicUrl}/undo/${inc.id}`,
  ].filter(Boolean).join('\n');
  console.log(`[${ctx.tenant.id}] ${text.split('\n')[0]}`);
  if (!ctx.settings.alertUrl) return;
  try {
    await fetch(ctx.settings.alertUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
  } catch (e) { console.error('alert failed', (e as Error).message); }
}
