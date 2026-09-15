import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DRY_RUN = '1';
process.env.REFUND_DELAY_MIN = '0';
const { demoCtx } = await import('../src/demo.ts');
const { detect } = await import('../src/detector.ts');
const { seed, attackBurst, launchBurst, history } = await import('../src/simulate.ts');
const { learnBaseline } = await import('../src/baseline.ts');
const { ingest } = await import('../src/engine.ts');
const { tick, undo, setLaunchMode } = await import('../src/responder.ts');

async function fresh() { const c = await demoCtx(':memory:'); await seed(c); return c; }

test('baseline learns sane numbers from synthetic history', () => {
  const b = learnBaseline(history(), 10, 60);
  assert.ok(b.total_paid > 800 && b.total_paid < 1600, `paid ${b.total_paid}`);
  assert.ok(b.new_buyer_share > 0.15 && b.new_buyer_share < 0.7, `new ${b.new_buyer_share}`);
  assert.ok(b.decline_share < 0.1);
  assert.ok(b.avg_usd > 45 && b.avg_usd < 75);
});

test('card-testing burst is an attack with suspects', async () => {
  const c = await fresh();
  const ps = attackBurst();
  for (const p of ps) await c.shop.upsertPayment(p);
  const v = detect({ baseline: (await c.shop.getBaseline())!, window: ps, firstSeen: await c.shop.firstSeen() });
  assert.equal(v.level, 'attack');
  assert.ok(v.score >= 4, `score ${v.score}`);
  assert.ok(v.suspects.length >= 30);
  assert.ok(v.signals.find((x) => x.name === 'card_reuse')!.fired);
  assert.ok(v.signals.find((x) => x.name === 'declines')!.fired);
});

test('a real launch does not trip: velocity + new buyers alone stay below attack', async () => {
  const c = await fresh();
  const ps = launchBurst();
  for (const p of ps) await c.shop.upsertPayment(p);
  const v = detect({ baseline: (await c.shop.getBaseline())!, window: ps, firstSeen: await c.shop.firstSeen() });
  assert.notEqual(v.level, 'attack', JSON.stringify(v.signals));
  assert.equal(v.suspects.length, 0);
});

test('quiet window is normal', async () => {
  const c = await fresh();
  const v = detect({ baseline: (await c.shop.getBaseline())!, window: [], firstSeen: await c.shop.firstSeen() });
  assert.equal(v.level, 'normal');
});

test('responder holds, then acts on tick; undo prevents action and snoozes', async () => {
  const c = await fresh(); c.settings.refundDelayMin = 0;
  let v = null;
  for (const p of attackBurst()) v = await ingest(c, p);
  assert.equal(v!.level, 'attack');
  const [inc] = await c.shop.openIncidents();
  assert.ok(inc, 'incident opened');
  assert.equal(inc.status, 'holding');
  await undo(c, inc.id);
  await tick(c);
  assert.equal((await c.shop.incident(inc.id))!.status, 'undone');
  assert.equal((await c.shop.incident(inc.id))!.acted, null);
  await ingest(c, { ...attackBurst()[0]!, id: 'pay_after_undo', user_id: 'user_bot_99' });
  assert.equal((await c.shop.openIncidents()).length, 0, 'undo snoozes the window');

  const c2 = await fresh(); c2.settings.refundDelayMin = 0;
  for (const p of attackBurst(Date.now(), 8)) await ingest(c2, p);
  await tick(c2);
  const done = (await c2.shop.incidents())[0]!;
  assert.equal(done.status, 'acted');
  assert.ok(done.acted!.refunded.length >= 30);
  assert.equal(done.acted!.errors.length, 0);
});

test('launch mode suppresses action but still records', async () => {
  const c = await fresh();
  await setLaunchMode(c, 2);
  for (const p of attackBurst()) await ingest(c, p);
  const inc = (await c.shop.incidents())[0]!;
  assert.equal(inc.status, 'alerted');
  assert.equal((await c.shop.openIncidents()).length, 0);
});
