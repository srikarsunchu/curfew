import type { Ctx } from './tenant.ts';
import type { Incident, Verdict } from './types.ts';
import { sendAlert } from './alert.ts';

/**
 * Attack handling, designed so the scary part is undoable:
 *  - immediately: alert with the signals and a one-click undo link; optionally revoke access now
 *  - after refundDelayMin: revoke + refund every suspect, unless undone or launch mode is on
 * Refunds are the one thing that cannot be undone, so they always wait.
 */
export async function respond(ctx: Ctx, verdict: Verdict): Promise<Incident | null> {
  const { shop } = ctx;
  if (verdict.level === 'normal') return null;
  if (await snoozed(ctx)) return null; // just undone: the same window would re-trip on the next payment
  if (await launchModeActive(ctx)) {
    const inc = await shop.openIncident(base(ctx, verdict, 'alerted'));
    await sendAlert(ctx, inc, verdict, 'launch mode on, not acting');
    return inc;
  }
  if (verdict.level === 'elevated') {
    if ((await shop.openIncidents()).length) return null;
    const inc = await shop.openIncident(base(ctx, verdict, 'alerted'));
    await sendAlert(ctx, inc, verdict, 'elevated, watching');
    return inc;
  }
  const open = (await shop.openIncidents())[0];
  if (open) {
    const ids = new Set([...open.suspect_ids, ...verdict.suspects.map((p) => p.id)]);
    await shop.updateIncident(open.id, { suspect_ids: [...ids] });
    return shop.incident(open.id);
  }
  const inc = await shop.openIncident(base(ctx, verdict, 'holding'));
  if (ctx.settings.immediateRevoke) await revokeAll(ctx, inc);
  await sendAlert(ctx, inc, verdict, `holding, refund+revoke in ${ctx.settings.refundDelayMin}m unless undone`);
  return inc;
}

function base(ctx: Ctx, v: Verdict, status: Incident['status']): Omit<Incident, 'id'> {
  return {
    opened_at: new Date().toISOString(), level: v.level, score: v.score, signals: v.signals,
    suspect_ids: v.suspects.map((p) => p.id), status,
    act_at: new Date(Date.now() + ctx.settings.refundDelayMin * 60_000).toISOString(), acted: null,
  };
}

/** Called on a timer per tenant. Fires any hold whose delay has elapsed. */
export async function tick(ctx: Ctx) {
  for (const inc of await ctx.shop.openIncidents()) {
    if (new Date(inc.act_at) > new Date()) continue;
    if (await launchModeActive(ctx)) { await ctx.shop.updateIncident(inc.id, { status: 'undone' }); continue; }
    await act(ctx, inc);
  }
}

export async function act(ctx: Ctx, inc: Incident) {
  const { shop } = ctx;
  const acted = inc.acted ?? { refunded: [], revoked: [], errors: [] };
  const byId = new Map((await shop.allPayments()).map((p) => [p.id, p]));
  for (const id of inc.suspect_ids) {
    const p = byId.get(id);
    if (!p || p.refunded_at || acted.refunded.includes(id)) continue;
    try {
      if (p.membership_id && !acted.revoked.includes(p.membership_id)) { if (ctx.whop) await ctx.whop.revokeMembership(p.membership_id); acted.revoked.push(p.membership_id); }
      if (ctx.whop) await ctx.whop.refundPayment(id);
      acted.refunded.push(id);
      await shop.upsertPayment({ ...p, refunded_at: new Date().toISOString() });
    } catch (e) { acted.errors.push(`${id}: ${(e as Error).message}`); }
  }
  await shop.updateIncident(inc.id, { status: 'acted', acted });
  await sendAlert(ctx, (await shop.incident(inc.id))!, null, `acted: ${acted.refunded.length} refunded, ${acted.revoked.length} revoked, ${acted.errors.length} errors`);
}

async function revokeAll(ctx: Ctx, inc: Incident) {
  const acted = { refunded: [] as string[], revoked: [] as string[], errors: [] as string[] };
  const byId = new Map((await ctx.shop.allPayments()).map((p) => [p.id, p]));
  for (const id of inc.suspect_ids) {
    const m = byId.get(id)?.membership_id; if (!m) continue;
    try { if (ctx.whop) await ctx.whop.revokeMembership(m); acted.revoked.push(m); } catch (e) { acted.errors.push(`${m}: ${(e as Error).message}`); }
  }
  await ctx.shop.updateIncident(inc.id, { acted });
}

export async function undo(ctx: Ctx, id: number): Promise<Incident | null> {
  const inc = await ctx.shop.incident(id); if (!inc || inc.status !== 'holding') return inc;
  await ctx.shop.updateIncident(id, { status: 'undone' });
  await ctx.shop.setKV('snooze_until', new Date(Date.now() + ctx.settings.windowMin * 60_000).toISOString());
  return ctx.shop.incident(id);
}
async function snoozed(ctx: Ctx): Promise<boolean> {
  const until = await ctx.shop.getKV<string | null>('snooze_until');
  return !!until && new Date(until) > new Date();
}
export function setLaunchMode(ctx: Ctx, hours: number) {
  return ctx.shop.setKV('launch_until', hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null);
}
export async function launchModeActive(ctx: Ctx): Promise<boolean> {
  const until = await ctx.shop.getKV<string | null>('launch_until');
  return !!until && new Date(until) > new Date();
}
