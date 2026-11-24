import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Empty in development (Vite proxies to the local API). When the dashboard is hosted separately from
// the API, set VITE_API_URL at build time to the API's address, e.g. https://my-api.onrender.com
const API = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const POLL_MS = 3000;
const ROUTES = ['public', 'search', 'spike', 'login', 'account'];
const WARN = 0.05; // amber above 5% denied
const ALARM = 0.25; // red above 25% denied

const fmt = (n) => n.toLocaleString('en-US');
const pct = (r) => `${(r * 100).toFixed(r > 0 && r < 0.1 ? 1 : 0)}%`;

function gateState(rate, total) {
  if (!total) return { level: 'idle', text: 'No traffic in the last 5 minutes. Send a request to an /api route to see it here.' };
  if (rate >= ALARM) return { level: 'red', text: `Heavy throttling. ${pct(rate)} of requests were denied in the last 5 minutes.` };
  if (rate >= WARN) return { level: 'amber', text: `Some clients are hitting their limits. ${pct(rate)} of requests were denied in the last 5 minutes.` };
  return { level: 'green', text: `Traffic is flowing. ${pct(rate)} of requests were denied in the last 5 minutes.` };
}

function useApi() {
  const [token, setToken] = useState(null);
  const [needsToken, setNeedsToken] = useState(false);

  useEffect(() => {
    // In development the API can mint an admin token. In production this 404s and you paste one in.
    fetch(`${API}/dev/token?sub=dashboard&role=admin`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setToken(d.token))
      .catch(() => setNeedsToken(true));
  }, []);

  const call = useCallback(
    async (path, opts = {}) => {
      const res = await fetch(`${API}${path}`, {
        ...opts,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers || {}) },
      });
      if (res.status === 401 || res.status === 403) throw new Error('auth');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `Request failed (${res.status})`);
      return res.json();
    },
    [token],
  );
  return { token, setToken, needsToken: needsToken && !token, call, ready: Boolean(token) };
}

function Gate({ level, text }) {
  const lamps = [['red', 'Red lamp'], ['amber', 'Amber lamp'], ['green', 'Green lamp']];
  return (
    <section className="gate" aria-label="Gate status">
      <div className="housing" role="img" aria-label={`Signal is ${level}`}>
        {lamps.map(([c]) => (
          <span key={c} className={`lamp ${c} ${level === c ? 'on' : ''}`} />
        ))}
      </div>
      <p className="gate-text" role="status">{text}</p>
    </section>
  );
}

function Readout({ label, value, note }) {
  return (
    <div className="readout">
      <div className="readout-value">{fmt(value)}</div>
      <div className="readout-label">{label}</div>
      {note && <div className="readout-note">{note}</div>}
    </div>
  );
}

function Chart({ series }) {
  const W = 600, H = 150, pad = 4;
  const max = Math.max(5, ...series.map((s) => s.allowed + s.denied));
  const bw = (W - pad * 2) / Math.max(series.length, 1);
  return (
    <figure className="chart">
      <figcaption>Requests per minute, last {series.length} minutes</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Allowed and denied requests per minute">
        <line x1="0" x2={W} y1={H} y2={H} className="axis" />
        {series.map((s, i) => {
          const x = pad + i * bw;
          const hA = (s.allowed / max) * (H - 8);
          const hD = (s.denied / max) * (H - 8);
          return (
            <g key={s.minute}>
              <rect x={x + 1.5} y={H - hA} width={Math.max(bw - 3, 1)} height={hA} className="bar-ok" />
              <rect x={x + 1.5} y={H - hA - hD} width={Math.max(bw - 3, 1)} height={hD} className="bar-denied" />
            </g>
          );
        })}
        <text x="0" y={H + 14} className="tick">{series.length}m ago</text>
        <text x={W} y={H + 14} textAnchor="end" className="tick">now</text>
        <text x={W} y="10" textAnchor="end" className="tick">peak {fmt(max)}</text>
      </svg>
      <div className="legend"><span className="sw ok" />Allowed <span className="sw denied" />Denied</div>
    </figure>
  );
}

function Throttled({ top }) {
  return (
    <section>
      <h2>Most throttled clients</h2>
      {top.length === 0 ? (
        <p className="empty">Nobody has been denied yet. Clients that hit a limit will appear here.</p>
      ) : (
        <table>
          <thead><tr><th>Client</th><th>Route</th><th className="num">Denied</th></tr></thead>
          <tbody>
            {top.map((t) => (
              <tr key={`${t.route}|${t.identity}`}>
                <td className="client">{t.identity}</td>
                <td>{t.route}</td>
                <td className="num">{fmt(t.denied)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Rules({ rules, onSave, onToggle, busy, error }) {
  const [route, setRoute] = useState(ROUTES[0]);
  const [value, setValue] = useState('');
  const field = route === 'spike' ? 'bucketSize' : 'limit';
  const submit = (e) => {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    onSave(route, { [field]: n }).then(() => setValue(''));
  };
  return (
    <section>
      <h2>Limit overrides</h2>
      {rules.length === 0 ? (
        <p className="empty">No overrides. Every route uses its built-in limit. Add one below to change a limit without restarting the server.</p>
      ) : (
        <table>
          <thead><tr><th>Route</th><th className="num">Limit</th><th>Status</th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="num">{fmt(r.limit ?? r.bucketSize ?? 0)}</td>
                <td>
                  <button className="link" onClick={() => onToggle(r)} disabled={busy}>
                    {r.enabled === false ? 'Disabled · turn on' : 'Active · turn off'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="override" onSubmit={submit}>
        <label>Route
          <select value={route} onChange={(e) => setRoute(e.target.value)}>
            {ROUTES.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label>{field === 'bucketSize' ? 'Bucket size' : 'Requests per window'}
          <input type="number" min="1" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 5" />
        </label>
        <button type="submit" disabled={busy || !value}>Save override</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

export default function App() {
  const { token, setToken, needsToken, call, ready } = useApi();
  const [summary, setSummary] = useState(null);
  const [series, setSeries] = useState([]);
  const [top, setTop] = useState([]);
  const [rules, setRules] = useState([]);
  const [error, setError] = useState('');
  const [ruleError, setRuleError] = useState('');
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState(null);
  const [draft, setDraft] = useState('');
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const [s, ser, t, r] = await Promise.all([
        call('/metrics?minutes=5'),
        call('/metrics/series?minutes=30'),
        call('/metrics/top-throttled?n=8'),
        call('/admin/rules'),
      ]);
      setSummary(s); setSeries(ser.series); setTop(t.top); setRules(r.rules);
      setError(''); setUpdated(new Date());
    } catch (e) {
      setError(e.message === 'auth'
        ? 'The token was rejected. Paste a valid admin token to continue.'
        : `Cannot reach the API${API ? ` at ${API}` : ''}. Check that the server is running and, if the dashboard is hosted separately, that VITE_API_URL and the server's CORS_ORIGIN are set.`);
      if (e.message === 'auth') setToken(null);
    }
  }, [call, setToken]);

  useEffect(() => {
    if (!ready) return undefined;
    load();
    timer.current = setInterval(load, POLL_MS);
    return () => clearInterval(timer.current);
  }, [ready, load]);

  const save = async (name, data) => {
    setBusy(true); setRuleError('');
    try { await call(`/admin/rules/${name}`, { method: 'PUT', body: JSON.stringify(data) }); await load(); }
    catch (e) { setRuleError(e.message); }
    finally { setBusy(false); }
  };
  const toggle = (r) => save(r.name, { enabled: r.enabled === false });

  const gate = useMemo(() => gateState(summary?.denyRate ?? 0, (summary?.allowed ?? 0) + (summary?.denied ?? 0)), [summary]);

  if (needsToken) {
    return (
      <main className="shell narrow">
        <h1>Checkpoint</h1>
        <p>This console needs an admin token. Paste one to sign in.</p>
        <form className="override" onSubmit={(e) => { e.preventDefault(); setToken(draft.trim()); }}>
          <label>Admin token<input value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" /></label>
          <button type="submit" disabled={!draft.trim()}>Sign in</button>
        </form>
      </main>
    );
  }

  return (
    <main className="shell">
      <header>
        <h1>Checkpoint</h1>
        <p className="sub">Live view of who the rate limiter is letting through and who it is stopping.{updated && <span> Updated {updated.toLocaleTimeString()}.</span>}</p>
      </header>
      {error && <p className="error banner" role="alert">{error}</p>}
      <div className="grid">
        <Gate {...gate} />
        <div className="main">
          <div className="readouts">
            <Readout label="Allowed" value={summary?.allowed ?? 0} note="last 5 minutes" />
            <Readout label="Denied" value={summary?.denied ?? 0} note="last 5 minutes" />
            <Readout label="Let through while Redis was down" value={summary?.bypassed ?? 0} note="fail-open routes only" />
          </div>
          <Chart series={series} />
          <div className="two">
            <Throttled top={top} />
            <Rules rules={rules} onSave={save} onToggle={toggle} busy={busy} error={ruleError} />
          </div>
        </div>
      </div>
    </main>
  );
}
