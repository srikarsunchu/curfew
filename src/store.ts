import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import type { Baseline, Incident, Payment } from './types.ts';

export class Store {
  db: DatabaseSync;
  constructor(path = config.dbPath) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists payments (
        id text primary key, status text, created_at text, usd_total real,
        user_id text, member_id text, membership_id text, country text,
        card_fingerprint text, card_last4 text, decline_code text, refunded_at text
      );
      create index if not exists payments_created on payments(created_at);
      create index if not exists payments_user on payments(user_id);
      create table if not exists kv (k text primary key, v text);
      create table if not exists incidents (
        id integer primary key autoincrement, opened_at text, level text, score int,
        signals text, suspect_ids text, status text, act_at text, acted text
      );
      create table if not exists seen (id text primary key);
    `);
  }

  upsertPayment(p: Payment) {
    this.db.prepare(`insert into payments values (?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(id) do update set status=excluded.status, decline_code=excluded.decline_code, refunded_at=excluded.refunded_at`)
      .run(p.id, p.status, p.created_at, p.usd_total, p.user_id, p.member_id, p.membership_id, p.country,
           p.card_fingerprint, p.card_last4, p.decline_code, p.refunded_at);
  }

  paymentsSince(iso: string): Payment[] {
    return this.db.prepare('select * from payments where created_at >= ? order by created_at').all(iso) as Payment[];
  }
  allPayments(): Payment[] {
    return this.db.prepare('select * from payments order by created_at').all() as Payment[];
  }
  /** First payment timestamp per user, used to decide "new buyer". */
  firstSeen(): Map<string, string> {
    const rows = this.db.prepare('select user_id, min(created_at) as first from payments where user_id is not null group by user_id').all() as { user_id: string; first: string }[];
    return new Map(rows.map((r) => [r.user_id, r.first]));
  }

  /** Dedupe webhook deliveries by message id. Returns true if new. */
  markSeen(id: string): boolean {
    try { this.db.prepare('insert into seen values (?)').run(id); return true; } catch { return false; }
  }

  getKV<T>(k: string): T | null {
    const r = this.db.prepare('select v from kv where k = ?').get(k) as { v: string } | undefined;
    return r ? (JSON.parse(r.v) as T) : null;
  }
  setKV(k: string, v: unknown) {
    this.db.prepare('insert into kv values (?,?) on conflict(k) do update set v=excluded.v').run(k, JSON.stringify(v));
  }
  get baseline() { return this.getKV<Baseline>('baseline'); }
  set baseline(b: Baseline | null) { this.setKV('baseline', b); }

  openIncident(i: Omit<Incident, 'id'>): Incident {
    const r = this.db.prepare('insert into incidents (opened_at,level,score,signals,suspect_ids,status,act_at,acted) values (?,?,?,?,?,?,?,?)')
      .run(i.opened_at, i.level, i.score, JSON.stringify(i.signals), JSON.stringify(i.suspect_ids), i.status, i.act_at, JSON.stringify(i.acted));
    return { ...i, id: Number(r.lastInsertRowid) };
  }
  updateIncident(id: number, patch: Partial<Incident>) {
    const cur = this.incident(id); if (!cur) return;
    const n = { ...cur, ...patch };
    this.db.prepare('update incidents set status=?, acted=?, suspect_ids=? where id=?')
      .run(n.status, JSON.stringify(n.acted), JSON.stringify(n.suspect_ids), id);
  }
  incident(id: number): Incident | null {
    const r = this.db.prepare('select * from incidents where id = ?').get(id) as any;
    return r ? hydrate(r) : null;
  }
  incidents(limit = 50): Incident[] {
    return (this.db.prepare('select * from incidents order by id desc limit ?').all(limit) as any[]).map(hydrate);
  }
  openIncidents(): Incident[] {
    return (this.db.prepare(`select * from incidents where status = 'holding'`).all() as any[]).map(hydrate);
  }
}

function hydrate(r: any): Incident {
  return { ...r, signals: JSON.parse(r.signals), suspect_ids: JSON.parse(r.suspect_ids), acted: JSON.parse(r.acted) };
}
