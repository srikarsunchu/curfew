// Records the Curfew dashboard as a PNG frame sequence while driving the demo server.
// Run from the frame repo (it has puppeteer): node ../curfew/film/capture.mjs
// Expects: PORT=8797 DRY_RUN=1 npm start   (in the curfew repo)
import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE = process.env.CURFEW_URL ?? 'http://localhost:8797';
const OUT = resolve(process.env.OUT ?? '/private/tmp/claude-501/-Users-srikarsunchu-workspace-frame/13611289-5862-4195-be58-d121993cac2e/scratchpad/film/frames');
const FPS = 30, W = 1476, H = 938;
const post = (kind, extra = {}) => fetch(`${BASE}/api/simulate`, { method: 'POST', body: JSON.stringify({ kind, ...extra }) }).then((r) => r.json());
const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); // cubic inOut

// ---- timeline (seconds) ----
const T = {
  attackStart: 3.0, attackEnd: 8.2,        // stepped ingestion, 80 payments
  toSignals: 8.8,                          // cursor glides to the signals card
  scrollPayments: 11.6, clickRow: 13.2,    // scroll down, click the top payment
  scrollIncidents: 15.0,                   // scroll to incidents, hover the button
  act: 18.2,                               // refund + revoke fires
  end: 23.0,
};
// captions live in composite.py; keep the two files' times in sync.

await post('reset'); await post('normal');

const browser = await puppeteer.launch({ headless: true, args: ['--hide-scrollbars', `--window-size=${W},${H}`] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
// The story happens at 3:12 AM. Shift the page clock so every rendered time agrees.
const target = new Date(); target.setHours(3, 12, 0, 0);
const offset = target.getTime() - Date.now();
// Only displayed times shift; Date.now stays real so the 60-minute window still matches the server.
await page.evaluateOnNewDocument((offset) => {
  const orig = Date.prototype.toLocaleTimeString;
  Date.prototype.toLocaleTimeString = function (...a) { return orig.apply(new Date(this.getTime() + offset), a); };
}, offset);
await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
await page.addStyleTag({ content: `
  .demo{display:none !important} #payments tbody tr:nth-child(n+9){display:none} ::-webkit-scrollbar{display:none} html{scrollbar-width:none} html,body{height:auto !important;overflow:visible !important}
  .cur{position:fixed;left:0;top:0;width:22px;height:22px;z-index:99999;pointer-events:none;filter:drop-shadow(0 1px 1.5px #0009)}
  *,*::before,*::after{transition:none !important;animation:none !important}` });
await page.evaluate(() => {
  const c = document.createElement('div'); c.className = 'cur';
  c.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M4 2 L4 18.5 L8.2 14.6 L11 20.6 L13.6 19.5 L10.8 13.6 L16.6 13.6 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
});
await mkdir(OUT, { recursive: true });

// cursor keyframes: [time, x, y]
const cursorKeys = [[0, 1180, 330], [2.4, 1180, 330], [4.4, 300, 250], [8.2, 300, 250], [8.8, 300, 250], [10.4, 1180, 470], [11.6, 1180, 470], [13.0, 520, 640], [13.2, 520, 640], [15.0, 520, 640], [16.4, 1290, 560], [23, 1290, 560]];
let scrollKeys = [[0, 0], [11.6, 0], [12.6, 0], [15.0, 0], [16.0, 0], [20.8, 0], [21.8, 0], [23, 0]];
const topOf = (sel) => page.evaluate((sel) => { const r = document.querySelector(sel).closest('.card').getBoundingClientRect(); return Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight, r.top + scrollY - 24)); }, sel);
function interp(keys, t) {
  let i = 0; while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const [t0, ...a] = keys[i], [t1, ...b] = keys[i + 1];
  const k = t1 === t0 ? 1 : ease(Math.min(1, Math.max(0, (t - t0) / (t1 - t0))));
  return a.map((v, j) => v + (b[j] - v) * k);
}
let ingested = 0, clicked = false, acted = false;
const total = Math.round(T.end * FPS);
for (let f = 0; f < total; f++) {
  const t = f / FPS;
  if (t >= T.attackStart && t <= T.attackEnd) {
    const upto = Math.min(80, Math.ceil(80 * (t - T.attackStart) / (T.attackEnd - T.attackStart)));
    if (upto > ingested) { await post('attack', { upto }); ingested = upto; await page.evaluate(() => window.load()); }
  }
  if (t >= T.scrollPayments - 0.05 && scrollKeys[2][1] === 0) { const y = await topOf('#payments'); scrollKeys[2][1] = y; scrollKeys[3][1] = y; }
  if (t >= T.scrollIncidents - 0.05 && scrollKeys[4][1] === 0) {
    const y = await topOf('#incidents'); scrollKeys[4][1] = y; scrollKeys[5][1] = y;
    const b = await page.evaluate(() => { const el = document.querySelector('#incidents .btn.classic'); if (!el) return null; const q = el.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2 + scrollY]; });
    if (b) { cursorKeys[10] = [16.4, b[0], b[1] - y]; cursorKeys[11] = [20.8, b[0], b[1] - y]; cursorKeys.push([21.8, b[0] - 40, b[1] - y - 200], [23, b[0] - 40, b[1] - y - 200]); }
  }
  if (!clicked && t >= T.clickRow) { clicked = true; await page.evaluate(() => document.querySelector('tr[data-id]')?.click()); }
  if (!acted && t >= T.act) { acted = true; await post('act'); await page.evaluate(() => window.load()); }
  const [cx, cy] = interp(cursorKeys, t); const [sy] = interp(scrollKeys, t);
  await page.evaluate((cx, cy, sy) => { document.querySelector('.cur').style.transform = `translate(${cx}px,${cy}px)`; window.scrollTo(0, sy); }, cx, cy, sy);
  const png = await page.screenshot({ type: 'png' });
  await writeFile(`${OUT}/${String(f).padStart(4, '0')}.png`, png);
  if (f % 60 === 0) console.log(`frame ${f}/${total} t=${t.toFixed(1)} ingested=${ingested}`);
}
await browser.close();
console.log('done', total, 'frames ->', OUT);
