/**
 * Sends realistic mixed traffic to a RUNNING server so the dashboard has something to show:
 * well-behaved clients (never denied) plus three abusive ones (denied a lot).
 *
 *   node scripts/load-demo.js            # 90 seconds against http://127.0.0.1:3000
 *   node scripts/load-demo.js 180        # run for 180 seconds
 *   $env:BASE="http://127.0.0.1:3001"; node scripts/load-demo.js
 *
 * API keys are hashed before they reach Redis or the dashboard, so the dashboard shows names like
 * key:3f9a1c2b7d4e5a60. This script prints which hash belongs to which client (dev servers only).
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const SECONDS = Number(process.argv[2] || 90);

// requests per second each client sends. Limits: search 20/10s (2/s), public 10/min, spike burst 10 + 2/s.
const clients = [
  { key: 'alice',    path: '/api/search', rps: 1 },   // polite: stays under the limit
  { key: 'bob',      path: '/api/search', rps: 1.5 }, // polite
  { key: 'carol',    path: '/api/public', rps: 0.1 }, // polite: ~6 per minute
  { key: 'scraper',  path: '/api/search', rps: 10 },  // abusive: 5x over the limit
  { key: 'abuser',   path: '/api/public', rps: 5 },   // abusive: burns its 10 in 2 seconds
  { key: 'bot',      path: '/api/spike',  rps: 6 },   // abusive: 3x the refill rate
];

const stats = new Map(); // key -> { ok, denied, other }
for (const c of clients) stats.set(c.key, { ok: 0, denied: 0, other: 0 });

async function hit(c) {
  const s = stats.get(c.key);
  try {
    const res = await fetch(BASE + c.path, { headers: { 'x-api-key': c.key } });
    await res.arrayBuffer();
    if (res.status === 200) s.ok++;
    else if (res.status === 429) s.denied++;
    else s.other++;
  } catch {
    s.other++;
  }
}

function report(prefix) {
  console.log(prefix);
  for (const c of clients) {
    const s = stats.get(c.key);
    console.log(`  ${c.key.padEnd(8)} ${c.path.padEnd(12)} allowed ${String(s.ok).padStart(5)}   denied ${String(s.denied).padStart(5)}${s.other ? `   errors ${s.other}` : ''}`);
  }
}

try {
  const r = await fetch(`${BASE}/health`);
  if (!r.ok) throw new Error(String(r.status));
} catch {
  console.error(`Cannot reach ${BASE}. Start the server first (npm start in /server).`);
  process.exit(1);
}

console.log(`Sending traffic to ${BASE} for ${SECONDS}s. Open the dashboard at http://localhost:5173\n`);
console.log('Who is who on the dashboard:');
for (const c of clients) {
  try {
    const { identity } = await (await fetch(`${BASE}/dev/identity?key=${c.key}`)).json();
    console.log(`  ${c.key.padEnd(8)} -> ${identity}`);
  } catch { /* identity lookup is dev-only; ignore */ }
}
console.log('');
const timers = clients.map((c) => {
  const every = 1000 / c.rps;
  return setInterval(() => hit(c), every);
});
const progress = setInterval(() => report(`\n--- progress ---`), 15000);

setTimeout(() => {
  timers.forEach(clearInterval);
  clearInterval(progress);
  setTimeout(() => { report('\n=== final ==='); process.exit(0); }, 500);
}, SECONDS * 1000);
