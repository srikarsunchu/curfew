import { createStore } from './store.ts';
import { learn, disconnect } from './tenant.ts';

const [cmd, arg] = process.argv.slice(2);
const store = createStore();

if (cmd === 'learn' && arg) {
  console.log(JSON.stringify(await learn(store, arg, Number(process.argv[4] ?? 60)), null, 2));
} else if (cmd === 'tenants') {
  for (const id of await store.tenantIds()) { const t = (await store.tenant(id))!; console.log(id, '\t', t.title, '\t', t.account_id, '\t', t.webhook_id ? 'webhook ok' : 'no webhook'); }
} else if (cmd === 'disconnect' && arg) {
  await disconnect(store, arg); console.log('removed', arg);
} else {
  console.log('usage: cli.ts tenants | learn <tenantId> [days] | disconnect <tenantId>');
}
process.exit(0);
