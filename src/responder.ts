import { config } from './config.ts';
import type { Store } from './store.ts';
import type { Incident, Verdict } from './types.ts';
import { refundPayment, revokeMembership } from './whop.ts';
import { sendAlert } from './alert.ts';

/**
 * Attack handling, designed so the scary part is undoable:
 *  - immediately: alert with the signals and a one-click undo link; optionally revoke access now
 *  - after REFUND_DELAY_MIN: revoke + refund every suspect, unless undone or launch mode is on
 * Refunds are the one thing that cannot be undone, so they always wait.
 */
export async function respond(store: Store, verdict: Verdict): Promise<Incident | null> {
  if (verdict.level === 'normal') return null;
  if (snoozed(store)) return null; // just undone: the same window would re-trip on the next payment
  if (launchModeActive(store)) {
    // Still record it, still alert, never act.
    const inc = store.openIncident(base(verdict, 'alerted'));
    await sendAlert(store, inc, verdict, 'launch mode on, not acting');
    return inc;
  }
  if (verdict.level === 'elevated') {
    if (store.openIncidents().length) return null; // already holding, don't spam
    const inc = store.openIncident(base(verdict, 'alerted'));
    await sendAlert(store, inc, verdict, 'elevated, watching');
    return inc;
  }
  // attack
  const open = store.openIncidents()[0];
  if (open) {
    // fold new suspects into the existing hold
    const ids = new Set([...open.suspect_ids, ...verdict.suspects.map((p) => p.id)]);
    store.updateIncident(open.id, { suspect_ids: [...ids] });
    return store.incident(open.id);
  }
  const inc = store.openIncident(base(verdict, 'holding'));
  if (config.immediateRevoke) await revokeAll(store, inc);
  await sendAlert(store, inc, verdict, `holding, refund+revoke in ${config.refundDelayMin}m unless undone`);
  return inc;
}

function base(v: Verdict, status: Incident['status']): Omit<Incident, 'id'> {
  return {
    opened_at: new Date().toISOString(), level: v.level, score: v.score, signals: v.signals,
    suspect_ids: v.suspects.map((p) => p.id), status,
    act_at: new Date(Date.now() + config.refundDelayMin * 60_000).toISOString(), acted: null,
  };
}

/** Called on a timer. Fires any hold whose delay has elapsed. */
export async function tick(store: Store) {
  for (const inc of store.openIncidents()) {
    if (new Date(inc.act_at) > new Date()) continue;
    if (launchModeActive(store)) { store.updateIncident(inc.id, { status: 'undone' }); continue; }
    await act(store, inc);
  }
}

export async function act(store: Store, inc: Incident) {
  const acted = inc.acted ?? { refunded: [], revoked: [], errors: [] };
  const byId = new Map(store.allPayments().map((p) => [p.id, p]));
  for (const id of inc.suspect_ids) {
    const p = byId.get(id);
    if (!p || p.refunded_at || acted.refunded.includes(id)) continue;
    try {
      if (p.membership_id && !acted.revoked.includes(p.membership_id)) { await revokeMembership(p.membership_id); acted.revoked.push(p.membership_id); }
      await refundPayment(id); acted.refunded.push(id);
      store.upsertPayment({ ...p, refunded_at: new Date().toISOString() });
    } catch (e) { acted.errors.push(`${id}: ${(e as Error).message}`); }
  }
  store.updateIncident(inc.id, { status: 'acted', acted });
  await sendAlert(store, store.incident(inc.id)!, null, `acted: ${acted.refunded.length} refunded, ${acted.revoked.length} revoked, ${acted.errors.length} errors`);
}

async function revokeAll(store: Store, inc: Incident) {
  const acted = { refunded: [], revoked: [] as string[], errors: [] as string[] };
  const byId = new Map(store.allPayments().map((p) => [p.id, p]));
  for (const id of inc.suspect_ids) {
    const m = byId.get(id)?.membership_id; if (!m) continue;
    try { await revokeMembership(m); acted.revoked.push(m); } catch (e) { acted.errors.push(`${m}: ${(e as Error).message}`); }
  }
  store.updateIncident(inc.id, { acted });
}

export function undo(store: Store, id: number): Incident | null {
  const inc = store.incident(id); if (!inc || inc.status !== 'holding') return inc;
  store.updateIncident(id, { status: 'undone' });
  // Trust the current window: don't reopen on it. Fresh signals after the window rolls still fire.
  store.setKV('snooze_until', new Date(Date.now() + config.windowMin * 60_000).toISOString());
  return store.incident(id);
}
function snoozed(store: Store): boolean {
  const until = store.getKV<string | null>('snooze_until');
  return !!until && new Date(until) > new Date();
}

/** "I'm launching": suppress action for N hours. Alerts still fire so you can watch. */
export function setLaunchMode(store: Store, hours: number) {
  store.setKV('launch_until', hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null);
}
export function launchModeActive(store: Store): boolean {
  const until = store.getKV<string | null>('launch_until');
  return !!until && new Date(until) > new Date();
}
