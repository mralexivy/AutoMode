'use client';
import { useMemo, useState } from 'react';
import { addRequest, ANTHROPIC, netOf, NO_SAVINGS, type Savings } from '@/lib/mod';
import { Select } from './select';

// Watch a session pay back. It runs the bar's own savings code (hooks/lib/savings.ts) on a simulated chat: a few
// warm requests on the starting model, then a switch to a cheaper one. The new model writes the whole chat into its
// cache first, so the saving dips; each cheaper request then pays some of it back. Token counts are an example; the
// prices and the cache rules are the real ones.
const MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } as const;
const NAME = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' } as const;
type Fam = keyof typeof MODELS;
const CHEAPER: Record<Fam, Fam[]> = { opus: ['sonnet', 'haiku'], sonnet: ['haiku'], haiku: [] };
const HOUR = 3_600_000;
const NEW_TOKENS = 1_500; // new input each request: a message and a tool result
const OUT_TOKENS = 800;
const SAVING = '#0891b2'; // validated on the chart surface (dataviz validator, dark mode)
const PAYBACK = '#d97706';

function simulate(from: Fam, to: Fam, chat: number, after: number) {
  const step = (s: Savings, ran: Fam, prompt: number, fresh: number, i: number) =>
    addRequest(s, { appModel: MODELS[from], answeredModel: MODELS[ran], usage: { input: 2, output: OUT_TOKENS, cacheRead: prompt - fresh - 2, cacheWrite5m: 0, cacheWrite1h: fresh }, at: i * 60_000, ttlMs: HOUR }, ANTHROPIC);
  // The chat so far, warm on the starting model.
  let s = step(NO_SAVINGS, from, chat, chat, 0);
  let prompt = chat;
  const points = [0];
  for (let i = 1; i <= after; i++) {
    prompt += NEW_TOKENS;
    // The first request on the new model writes the whole chat into its cache; later ones write only what is new.
    s = step(s, to, prompt, i === 1 ? prompt : NEW_TOKENS, i);
    points.push(netOf(s));
  }
  const payback = points.findIndex((v, i) => i > 0 && v >= 0 && points[i - 1] < 0);
  return { points, rewrite: s.rewriteUsd, payback: payback > 0 ? payback : points[1] >= 0 ? 1 : null, end: points[points.length - 1], baseline: s.baselineUsd };
}

const money = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(Math.abs(x) < 1 ? 3 : 2)}`;

export function Payback() {
  const [from, setFrom] = useState<Fam>('opus');
  const [to, setTo] = useState<Fam>('sonnet');
  const [chat, setChat] = useState(80_000);
  const [after, setAfter] = useState(30);
  const [hover, setHover] = useState<number | null>(null);
  const target = CHEAPER[from].includes(to) ? to : CHEAPER[from][0];
  const r = useMemo(() => simulate(from, target, chat, after), [from, target, chat, after]);

  // Chart geometry: one y-axis in dollars, zero always in view.
  const W = 640, H = 240, L = 56, R = 16, T = 16, B = 32;
  const lo = Math.min(0, ...r.points), hi = Math.max(0, ...r.points);
  const pad = (hi - lo) * 0.08 || 0.01;
  const y = (v: number) => T + ((hi + pad - v) / (hi - lo + 2 * pad)) * (H - T - B);
  const x = (i: number) => L + (i / Math.max(1, r.points.length - 1)) * (W - L - R);
  const line = r.points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(r.points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const ticks = [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i);
  const h = hover ?? r.points.length - 1;

  const field = 'text-sm font-medium';
  return (
    <div className="not-prose my-6 rounded-xl border bg-fd-card p-5">
      <p className="font-semibold">Watch a switch pay back</p>
      <p className="mt-1 text-sm text-fd-muted-foreground">
        The same code as the bar&apos;s live saving, on an example chat. Real prices and cache rules; example token counts.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-4">
        <label className={field}>
          Session model
          <Select value={from} onChange={(e) => setFrom(e.target.value as Fam)}>
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
          </Select>
        </label>
        <label className={field}>
          Switches to
          <Select value={target} onChange={(e) => setTo(e.target.value as Fam)}>
            {CHEAPER[from].map((f) => (
              <option key={f} value={f}>
                {NAME[f]}
              </option>
            ))}
          </Select>
        </label>
        <label className={field}>
          Chat size at the switch
          <Select value={chat} onChange={(e) => setChat(Number(e.target.value))}>
            {[20_000, 50_000, 80_000, 120_000, 160_000].map((k) => (
              <option key={k} value={k}>
                {k / 1000}k tokens
              </option>
            ))}
          </Select>
        </label>
        <label className={field}>
          Requests after it: {after}
          <input className="mt-3 w-full accent-[#0891b2]" type="range" min={5} max={80} value={after} onChange={(e) => setAfter(Number(e.target.value))} />
        </label>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-5 w-full"
        role="img"
        aria-label={`Estimated saving after each request. The switch costs ${money(r.rewrite)} in cache rewrite${r.payback ? ` and pays back after ${r.payback} requests` : ' and does not pay back in this window'}. After ${after} requests: ${money(r.end)}.`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          setHover(Math.max(0, Math.min(r.points.length - 1, Math.round(((px - L) / (W - L - R)) * (r.points.length - 1)))));
        }}
      >
        <defs>
          <clipPath id="pb-up">
            <rect x={0} y={0} width={W} height={y(0)} />
          </clipPath>
          <clipPath id="pb-down">
            <rect x={0} y={y(0)} width={W} height={H} />
          </clipPath>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="currentColor" className={v === 0 ? 'text-fd-muted-foreground' : 'text-fd-border'} strokeWidth={1} strokeDasharray={v === 0 ? undefined : '3 4'} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" className="fill-fd-muted-foreground text-[11px]">
              {money(v)}
            </text>
          </g>
        ))}
        <path d={area} fill={SAVING} opacity={0.18} clipPath="url(#pb-up)" />
        <path d={area} fill={PAYBACK} opacity={0.22} clipPath="url(#pb-down)" />
        <path d={line} fill="none" stroke={SAVING} strokeWidth={2} strokeLinejoin="round" clipPath="url(#pb-up)" />
        <path d={line} fill="none" stroke={PAYBACK} strokeWidth={2} strokeLinejoin="round" clipPath="url(#pb-down)" />
        {r.payback ? (
          <g>
            <circle cx={x(r.payback)} cy={y(r.points[r.payback])} r={5} fill={SAVING} stroke="var(--color-fd-card)" strokeWidth={2} />
            <text x={x(r.payback) + 8} y={y(0) - 8} className="fill-fd-foreground text-[11px]">
              paid back · request {r.payback}
            </text>
          </g>
        ) : null}
        {r.points[1] < 0 ? (
          <text x={x(1) + 6} y={y(r.points[1]) + 16} className="fill-fd-foreground text-[11px]">
            cache rewrite
          </text>
        ) : null}
        <line x1={x(h)} x2={x(h)} y1={T} y2={H - B} stroke="currentColor" className="text-fd-muted-foreground" strokeWidth={1} opacity={0.5} />
        <circle cx={x(h)} cy={y(r.points[h])} r={4} fill={r.points[h] < 0 ? PAYBACK : SAVING} stroke="var(--color-fd-card)" strokeWidth={2} />
        <text x={W - R} y={H - 10} textAnchor="end" className="fill-fd-muted-foreground text-[11px]">
          requests after the switch →
        </text>
        <text x={L} y={H - 10} className="fill-fd-muted-foreground text-[11px]">
          switch
        </text>
      </svg>

      <div className="mt-2 text-sm" aria-live="polite">
        <b>Request {h}:</b>{' '}
        {h === 0 ? 'before the switch, nothing saved' : r.points[h] < 0 ? `↺ ${money(-r.points[h])} still to pay back` : `saved ~${money(r.points[h])} against ${NAME[from]}`}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border p-3">
          <div className="text-xs text-fd-muted-foreground">Cache rewrite at the switch</div>
          <div className="text-xl font-bold">{money(r.rewrite)}</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-xs text-fd-muted-foreground">Paid back after</div>
          <div className="text-xl font-bold">{r.payback ? `${r.payback} requests` : 'not in this window'}</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-xs text-fd-muted-foreground">After {after} requests</div>
          <div className="text-xl font-bold" style={{ color: r.end < 0 ? PAYBACK : SAVING }}>
            {r.end < 0 ? `−${money(-r.end).replace('−', '')}` : `~${money(r.end)}`}
          </div>
        </div>
      </div>
      <p className="mt-3 text-xs text-fd-muted-foreground">
        Example chat: {NEW_TOKENS.toLocaleString()} new tokens and {OUT_TOKENS} output tokens per request, 1-hour cache, one request a minute. AutoMode&apos;s
        judges are left out here; the bar counts them.
      </p>
    </div>
  );
}
