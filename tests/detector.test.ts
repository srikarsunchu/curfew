import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DRY_RUN = '1';
process.env.REFUND_DELAY_MIN = '0';
const { Store } = await import('../src/store.ts');
const { detect } = await import('../src/detector.ts');
const { seed, attackBurst, launchBurst, history } = await import('../src/simulate.ts');
const { learnBaseline } = await import('../src/baseline.ts');
const { ingest } = await import('../src/engine.ts');
const { tick, undo, setLaunchMode } = await import('../src/responder.ts');

function fresh() { const s = new Store(':memory:'); seed(s); return s; }

test('baseline learns sane numbers from synthetic history', () => {
  const b = learnBaseline(history(), 10, 60);
  assert.ok(b.total_paid > 800 && b.total_paid < 1600, `paid ${b.total_paid}`);
  assert.ok(b.new_buyer_share > 0.15 && b.new_buyer_share < 0.7, `new ${b.new_buyer_share}`);
  assert.ok(b.decline_share < 0.1);
  assert.ok(b.avg_usd > 45 && b.avg_usd < 75);
});

test('card-testing burst is an attack with suspects', () => {
  const s = fresh();
  const ps = attackBurst();
  for (const p of ps) s.upsertPayment(p);
  const v = detect({ baseline: s.baseline!, window: ps, firstSeen: s.firstSeen() });
  assert.equal(v.level, 'attack');
  assert.ok(v.score >= 4, `score ${v.score}`);
  assert.ok(v.suspects.length >= 30);
  assert.ok(v.signals.find((x) => x.name === 'card_reuse')!.fired);
  assert.ok(v.signals.find((x) => x.name === 'declines')!.fired);
});

test('a real launch does not trip: velocity + new buyers alone stay below attack', () => {
  const s = fresh();
  const ps = launchBurst();
  for (const p of ps) s.upsertPayment(p);
  const v = detect({ baseline: s.baseline!, window: ps, firstSeen: s.firstSeen() });
  assert.notEqual(v.level, 'attack', JSON.stringify(v.signals));
  assert.equal(v.suspects.length, 0);
});

test('quiet window is normal', () => {
  const s = fresh();
  const v = detect({ baseline: s.baseline!, window: [], firstSeen: s.firstSeen() });
  assert.equal(v.level, 'normal');
});

test('responder holds, then acts on tick; undo prevents action', async () => {
  const s = fresh();
  let v = null;
  for (const p of attackBurst()) v = await ingest(s, p);
  assert.equal(v!.level, 'attack');
  const [inc] = s.openIncidents();
  assert.ok(inc, 'incident opened');
  assert.equal(inc.status, 'holding');
  undo(s, inc.id);
  await tick(s);
  assert.equal(s.incident(inc.id)!.status, 'undone');
  assert.equal(s.incident(inc.id)!.acted, null);

  const s2 = fresh();
  for (const p of attackBurst(Date.now(), 8)) await ingest(s2, p);
  await tick(s2); // REFUND_DELAY_MIN=0 so it fires now (DRY_RUN, no API calls)
  const done = s2.incidents()[0]!;
  assert.equal(done.status, 'acted');
  assert.ok(done.acted!.refunded.length >= 30);
  assert.equal(done.acted!.errors.length, 0);
});

test('launch mode suppresses action but still records', async () => {
  const s = fresh();
  setLaunchMode(s, 2);
  for (const p of attackBurst()) await ingest(s, p);
  const inc = s.incidents()[0]!;
  assert.equal(inc.status, 'alerted');
  assert.equal(s.openIncidents().length, 0);
});
