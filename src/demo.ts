import { DEMO_TENANT } from './config.ts';
import { SqliteStore, type Store } from './store.ts';
import { ctxFor, defaultSettings, type Ctx } from './tenant.ts';

export const DEMO_OWNER_TOKEN = 'demo-owner';

/** The synthetic Northwind Picks tenant used by tests, the simulator and the dry-run server. */
export async function ensureDemoTenant(store: Store) {
  if (!(await store.tenant(DEMO_TENANT))) await store.createTenant({ id: DEMO_TENANT, title: 'Northwind Picks (demo)', account_id: null, api_key_enc: null, settings: defaultSettings(), ownerToken: DEMO_OWNER_TOKEN });
  return (await store.tenant(DEMO_TENANT))!;
}
export async function demoCtx(path = ':memory:', store: Store = new SqliteStore(path)): Promise<Ctx> {
  return ctxFor(store, await ensureDemoTenant(store));
}
