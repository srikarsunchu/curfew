import { DatabaseSync } from 'node:sqlite';
import postgres from 'postgres';
import { config, type Settings } from './config.ts';
import { sha256 } from './crypto.ts';
import type { Baseline, Incident, Payment } from './types.ts';

export type Tenant = {
  id: string; title: string; account_id: string | null; created_at: string;
  api_key_enc: string | null; webhook_id: string | null; webhook_secret_enc: string | null;
  settings: Settings;
};
export type NewTenant = { id: string; title: string; account_id: string | null; api_key_enc: string | null; settings: Settings; ownerToken: string };

/** Everything the app needs from storage. Two backends: SQLite for local/dry-run/tests, Postgres for Vercel. */
export interface Store {
  createTenant(t: NewTenant): Promise<Tenant>;
  tenant(id: string): Promise<Tenant | null>;
  tenantByToken(token: string): Promise<Tenant | null>;
  tenantByAccount(accountId: string): Promise<Tenant | null>;
  updateTenant(id: string, patch: Partial<Pick<Tenant, 'webhook_id' | 'webhook_secret_enc' | 'settings' | 'title' | 'api_key_enc'>>): Promise<void>;
  rotateOwnerToken(id: string, token: string): Promise<void>;
  deleteTenant(id: string): Promise<void>;
  tenantIds(): Promise<string[]>;
  shop(tenantId: string): Shop;
}
/** Per-tenant view. Everything the detector, responder and dashboard need. */
export interface Shop {
  tenantId: string;
  upsertPayment(p: Payment): Promise<void>;
  paymentsSince(iso: string): Promise<Payment[]>;
  allPayments(): Promise<Payment[]>;
  firstSeen(): Promise<Map<string, string>>;
  markSeen(id: string): Promise<boolean>;
  getKV<T>(k: string): Promise<T | null>;
  setKV(k: string, v: unknown): Promise<void>;
  getBaseline(): Promise<Baseline | null>;
  setBaseline(b: Baseline | null): Promise<void>;
  openIncident(i: Omit<Incident, 'id'>): Promise<Incident>;
  updateIncident(id: number, patch: Partial<Incident>): Promise<void>;
  incident(id: number): Promise<Incident | null>;
  incidents(limit?: number): Promise<Incident[]>;
  openIncidents(): Promise<Incident[]>;
  resetRecent(): Promise<void>;
}

const PAYMENT_COLS = ['id', 'status', 'created_at', 'usd_total', 'user_id', 'user_name', 'member_id', 'membership_id', 'country', 'card_fingerprint', 'card_last4', 'decline_code', 'refunded_at'] as const;
const hydrateTenant = (r: any): Tenant | null => (r ? { ...r, settings: typeof r.settings === 'string' ? JSON.parse(r.settings) : r.settings } : null);
const hydrateInc = (r: any): Incident => ({ ...r, id: Number(r.id), signals: parse(r.signals), suspect_ids: parse(r.suspect_ids), acted: parse(r.acted) });
const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
const cleanPayment = (r: any): Payment => ({ ...r, usd_total: Number(r.usd_total), created_at: iso(r.created_at), refunded_at: r.refunded_at ? iso(r.refunded_at) : null });
const iso = (v: any) => (v instanceof Date ? v.toISOString() : String(v));

export function createStore(): Store {
  return config.databaseUrl ? new PgStore(config.databaseUrl) : new SqliteStore(config.dbPath);
}

// ---------------- SQLite ----------------
export class SqliteStore implements Store {
  db: DatabaseSync;
  constructor(path = config.dbPath) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists tenants (id text primary key, title text, account_id text, created_at text, api_key_enc text, webhook_id text, webhook_secret_enc text, settings text, owner_token_hash text unique);
      create table if not exists payments (tenant_id text, id text, status text, created_at text, usd_total real, user_id text, user_name text, member_id text, membership_id text, country text, card_fingerprint text, card_last4 text, decline_code text, refunded_at text, primary key (tenant_id, id));
      create index if not exists payments_created on payments(tenant_id, created_at);
      create table if not exists kv (tenant_id text, k text, v text, primary key (tenant_id, k));
      create table if not exists incidents (id integer primary key autoincrement, tenant_id text, opened_at text, level text, score int, signals text, suspect_ids text, status text, act_at text, acted text);
      create table if not exists seen (tenant_id text, id text, primary key (tenant_id, id));
    `);
  }
  async createTenant(t: NewTenant) {
    this.db.prepare('insert into tenants values (?,?,?,?,?,?,?,?,?)').run(t.id, t.title, t.account_id, new Date().toISOString(), t.api_key_enc, null, null, JSON.stringify(t.settings), sha256(t.ownerToken));
    return (await this.tenant(t.id))!;
  }
  async tenant(id: string) { return hydrateTenant(this.db.prepare('select * from tenants where id = ?').get(id)); }
  async tenantByToken(token: string) { return hydrateTenant(this.db.prepare('select * from tenants where owner_token_hash = ?').get(sha256(token))); }
  async tenantByAccount(a: string) { return hydrateTenant(this.db.prepare('select * from tenants where account_id = ?').get(a)); }
  async updateTenant(id: string, patch: Partial<Tenant>) {
    const cur = await this.tenant(id); if (!cur) return; const n = { ...cur, ...patch };
    this.db.prepare('update tenants set title=?, api_key_enc=?, webhook_id=?, webhook_secret_enc=?, settings=? where id=?').run(n.title, n.api_key_enc, n.webhook_id, n.webhook_secret_enc, JSON.stringify(n.settings), id);
  }
  async rotateOwnerToken(id: string, token: string) { this.db.prepare('update tenants set owner_token_hash=? where id=?').run(sha256(token), id); }
  async deleteTenant(id: string) { for (const t of ['payments', 'kv', 'incidents', 'seen']) this.db.prepare(`delete from ${t} where tenant_id = ?`).run(id); this.db.prepare('delete from tenants where id = ?').run(id); }
  async tenantIds() { return (this.db.prepare('select id from tenants').all() as { id: string }[]).map((r) => r.id); }
  shop(tenantId: string): Shop { return new SqliteShop(this.db, tenantId); }
}
class SqliteShop implements Shop {
  db: DatabaseSync; tenantId: string;
  constructor(db: DatabaseSync, tenantId: string) { this.db = db; this.tenantId = tenantId; }
  async upsertPayment(p: Payment) {
    this.db.prepare(`insert into payments values (?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(tenant_id, id) do update set status=excluded.status, decline_code=excluded.decline_code, refunded_at=excluded.refunded_at`)
      .run(this.tenantId, ...PAYMENT_COLS.map((c) => (p as any)[c] ?? null));
  }
  async paymentsSince(iso: string) { return (this.db.prepare('select * from payments where tenant_id = ? and created_at >= ? order by created_at').all(this.tenantId, iso) as any[]).map(cleanPayment); }
  async allPayments() { return (this.db.prepare('select * from payments where tenant_id = ? order by created_at').all(this.tenantId) as any[]).map(cleanPayment); }
  async firstSeen() {
    const rows = this.db.prepare('select user_id, min(created_at) as first from payments where tenant_id = ? and user_id is not null group by user_id').all(this.tenantId) as { user_id: string; first: string }[];
    return new Map(rows.map((r) => [r.user_id, r.first]));
  }
  async markSeen(id: string) { try { this.db.prepare('insert into seen values (?,?)').run(this.tenantId, id); return true; } catch { return false; } }
  async getKV<T>(k: string) { const r = this.db.prepare('select v from kv where tenant_id = ? and k = ?').get(this.tenantId, k) as { v: string } | undefined; return r ? (JSON.parse(r.v) as T) : null; }
  async setKV(k: string, v: unknown) { this.db.prepare('insert into kv values (?,?,?) on conflict(tenant_id, k) do update set v=excluded.v').run(this.tenantId, k, JSON.stringify(v)); }
  getBaseline() { return this.getKV<Baseline>('baseline'); }
  setBaseline(b: Baseline | null) { return this.setKV('baseline', b); }
  async openIncident(i: Omit<Incident, 'id'>) {
    const r = this.db.prepare('insert into incidents (tenant_id,opened_at,level,score,signals,suspect_ids,status,act_at,acted) values (?,?,?,?,?,?,?,?,?)').run(this.tenantId, i.opened_at, i.level, i.score, JSON.stringify(i.signals), JSON.stringify(i.suspect_ids), i.status, i.act_at, JSON.stringify(i.acted));
    return { ...i, id: Number(r.lastInsertRowid) };
  }
  async updateIncident(id: number, patch: Partial<Incident>) {
    const cur = await this.incident(id); if (!cur) return; const n = { ...cur, ...patch };
    this.db.prepare('update incidents set status=?, acted=?, suspect_ids=? where id=? and tenant_id=?').run(n.status, JSON.stringify(n.acted), JSON.stringify(n.suspect_ids), id, this.tenantId);
  }
  async incident(id: number) { const r = this.db.prepare('select * from incidents where id = ? and tenant_id = ?').get(id, this.tenantId); return r ? hydrateInc(r) : null; }
  async incidents(limit = 50) { return (this.db.prepare('select * from incidents where tenant_id = ? order by id desc limit ?').all(this.tenantId, limit) as any[]).map(hydrateInc); }
  async openIncidents() { return (this.db.prepare(`select * from incidents where tenant_id = ? and status = 'holding'`).all(this.tenantId) as any[]).map(hydrateInc); }
  async resetRecent() {
    this.db.prepare('delete from payments where tenant_id = ? and created_at >= ?').run(this.tenantId, new Date(Date.now() - 3_600_000).toISOString());
    this.db.prepare('delete from incidents where tenant_id = ?').run(this.tenantId);
  }
}

// ---------------- Postgres ----------------
export class PgStore implements Store {
  sql: ReturnType<typeof postgres>;
  ready: Promise<void>;
  constructor(url: string) {
    this.sql = postgres(url, { max: 3, idle_timeout: 20, prepare: false, onnotice: () => {} });
    this.ready = this.sql.unsafe(`
      create table if not exists tenants (id text primary key, title text, account_id text, created_at text, api_key_enc text, webhook_id text, webhook_secret_enc text, settings text, owner_token_hash text unique);
      create table if not exists payments (tenant_id text, id text, status text, created_at text, usd_total double precision, user_id text, user_name text, member_id text, membership_id text, country text, card_fingerprint text, card_last4 text, decline_code text, refunded_at text, primary key (tenant_id, id));
      create index if not exists payments_created on payments(tenant_id, created_at);
      create table if not exists kv (tenant_id text, k text, v text, primary key (tenant_id, k));
      create table if not exists incidents (id bigserial primary key, tenant_id text, opened_at text, level text, score int, signals text, suspect_ids text, status text, act_at text, acted text);
      create index if not exists incidents_tenant on incidents(tenant_id, status);
      create table if not exists seen (tenant_id text, id text, primary key (tenant_id, id));
    `).then(() => undefined);
  }
  async createTenant(t: NewTenant) {
    await this.ready;
    await this.sql`insert into tenants values (${t.id}, ${t.title}, ${t.account_id}, ${new Date().toISOString()}, ${t.api_key_enc}, null, null, ${JSON.stringify(t.settings)}, ${sha256(t.ownerToken)})`;
    return (await this.tenant(t.id))!;
  }
  async tenant(id: string) { await this.ready; return hydrateTenant((await this.sql`select * from tenants where id = ${id}`)[0]); }
  async tenantByToken(token: string) { await this.ready; return hydrateTenant((await this.sql`select * from tenants where owner_token_hash = ${sha256(token)}`)[0]); }
  async tenantByAccount(a: string) { await this.ready; return hydrateTenant((await this.sql`select * from tenants where account_id = ${a}`)[0]); }
  async updateTenant(id: string, patch: Partial<Tenant>) {
    const cur = await this.tenant(id); if (!cur) return; const n = { ...cur, ...patch };
    await this.sql`update tenants set title=${n.title}, api_key_enc=${n.api_key_enc}, webhook_id=${n.webhook_id}, webhook_secret_enc=${n.webhook_secret_enc}, settings=${JSON.stringify(n.settings)} where id=${id}`;
  }
  async rotateOwnerToken(id: string, token: string) { await this.sql`update tenants set owner_token_hash=${sha256(token)} where id=${id}`; }
  async deleteTenant(id: string) {
    await this.sql`delete from payments where tenant_id = ${id}`; await this.sql`delete from kv where tenant_id = ${id}`;
    await this.sql`delete from incidents where tenant_id = ${id}`; await this.sql`delete from seen where tenant_id = ${id}`;
    await this.sql`delete from tenants where id = ${id}`;
  }
  async tenantIds() { await this.ready; return (await this.sql`select id from tenants`).map((r) => r.id as string); }
  shop(tenantId: string): Shop { return new PgShop(this, tenantId); }
}
class PgShop implements Shop {
  tenantId: string; store: PgStore;
  constructor(store: PgStore, tenantId: string) { this.store = store; this.tenantId = tenantId; }
  get sql() { return this.store.sql; }
  async upsertPayment(p: Payment) {
    await this.store.ready;
    const row: any = { tenant_id: this.tenantId }; for (const c of PAYMENT_COLS) row[c] = (p as any)[c] ?? null;
    await this.sql`insert into payments ${this.sql(row)} on conflict (tenant_id, id) do update set status = excluded.status, decline_code = excluded.decline_code, refunded_at = excluded.refunded_at`;
  }
  async paymentsSince(iso: string) { await this.store.ready; return (await this.sql`select * from payments where tenant_id = ${this.tenantId} and created_at >= ${iso} order by created_at`).map(cleanPayment); }
  async allPayments() { await this.store.ready; return (await this.sql`select * from payments where tenant_id = ${this.tenantId} order by created_at`).map(cleanPayment); }
  async firstSeen() {
    const rows = await this.sql`select user_id, min(created_at) as first from payments where tenant_id = ${this.tenantId} and user_id is not null group by user_id`;
    return new Map(rows.map((r) => [r.user_id as string, r.first as string]));
  }
  async markSeen(id: string) { const r = await this.sql`insert into seen values (${this.tenantId}, ${id}) on conflict do nothing`; return r.count > 0; }
  async getKV<T>(k: string) { await this.store.ready; const r = (await this.sql`select v from kv where tenant_id = ${this.tenantId} and k = ${k}`)[0]; return r ? (JSON.parse(r.v) as T) : null; }
  async setKV(k: string, v: unknown) { await this.sql`insert into kv values (${this.tenantId}, ${k}, ${JSON.stringify(v)}) on conflict (tenant_id, k) do update set v = excluded.v`; }
  getBaseline() { return this.getKV<Baseline>('baseline'); }
  setBaseline(b: Baseline | null) { return this.setKV('baseline', b); }
  async openIncident(i: Omit<Incident, 'id'>) {
    const r = await this.sql`insert into incidents (tenant_id,opened_at,level,score,signals,suspect_ids,status,act_at,acted) values (${this.tenantId}, ${i.opened_at}, ${i.level}, ${i.score}, ${JSON.stringify(i.signals)}, ${JSON.stringify(i.suspect_ids)}, ${i.status}, ${i.act_at}, ${JSON.stringify(i.acted)}) returning id`;
    return { ...i, id: Number(r[0]!.id) };
  }
  async updateIncident(id: number, patch: Partial<Incident>) {
    const cur = await this.incident(id); if (!cur) return; const n = { ...cur, ...patch };
    await this.sql`update incidents set status=${n.status}, acted=${JSON.stringify(n.acted)}, suspect_ids=${JSON.stringify(n.suspect_ids)} where id=${id} and tenant_id=${this.tenantId}`;
  }
  async incident(id: number) { const r = (await this.sql`select * from incidents where id = ${id} and tenant_id = ${this.tenantId}`)[0]; return r ? hydrateInc(r) : null; }
  async incidents(limit = 50) { return (await this.sql`select * from incidents where tenant_id = ${this.tenantId} order by id desc limit ${limit}`).map(hydrateInc); }
  async openIncidents() { return (await this.sql`select * from incidents where tenant_id = ${this.tenantId} and status = 'holding'`).map(hydrateInc); }
  async resetRecent() {
    await this.sql`delete from payments where tenant_id = ${this.tenantId} and created_at >= ${new Date(Date.now() - 3_600_000).toISOString()}`;
    await this.sql`delete from incidents where tenant_id = ${this.tenantId}`;
  }
}
