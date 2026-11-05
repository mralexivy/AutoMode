'use client';
import { useState } from 'react';

// Per-step list-price costs from the five mixed sessions in bench/results: 10 questions and 10 coding tasks per arm.
const ARMS = {
  opus: { label: 'Claude Code on Opus (the default)', q: 0.05, t: 0.364 },
  sonnet: { label: 'Sonnet high', q: 0.024, t: 0.19 },
  effortless: { label: 'effortless, on Opus', q: 0.043, t: 0.344 },
};
const AUTO = { q: 0.008, t: 0.193 };
const WEEKS = 4.33;
type Arm = keyof typeof ARMS;

const money = (x: number) => `$${x.toFixed(2)}`;
const count = (v: string) => Math.max(0, Math.min(10000, Number(v) || 0));

export function Calculator() {
  const [q, setQ] = useState('50');
  const [t, setT] = useState('20');
  const [arm, setArm] = useState<Arm>('opus');
  const a = ARMS[arm];
  const now = (a.q * count(q) + a.t * count(t)) * WEEKS;
  const auto = (AUTO.q * count(q) + AUTO.t * count(t)) * WEEKS;
  const pct = now > 0 ? Math.round((1 - auto / now) * 100) : 0;
  const field = 'mt-1 w-full rounded-lg border bg-fd-background px-3 py-2 text-fd-foreground';

  return (
    <div className="not-prose my-6 rounded-xl border bg-fd-card p-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-sm font-medium">
          Questions per week
          <input className={field} type="number" min={0} max={10000} inputMode="numeric" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Coding tasks per week
          <input className={field} type="number" min={0} max={10000} inputMode="numeric" value={t} onChange={(e) => setT(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          What you run today
          <select className={field} value={arm} onChange={(e) => setArm(e.target.value as Arm)}>
            {Object.entries(ARMS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3" aria-live="polite">
        <div className="rounded-lg border p-4">
          <div className="text-xs text-fd-muted-foreground">{a.label}, per month</div>
          <div className="text-2xl font-bold">{money(now)}</div>
        </div>
        <div className="rounded-lg border border-fd-primary/50 p-4">
          <div className="text-xs text-fd-muted-foreground">AutoMode, per month</div>
          <div className="text-2xl font-bold text-fd-primary">{money(auto)}</div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-xs text-fd-muted-foreground">Difference</div>
          <div className="text-2xl font-bold">{pct >= 0 ? `${pct}% less` : `${-pct}% more`}</div>
        </div>
      </div>
      <p className="mt-3 text-xs text-fd-muted-foreground">List price. A month here is {WEEKS} weeks.</p>
    </div>
  );
}

export const calculatorCosts = { ARMS, AUTO, WEEKS };
