import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, MODEL, mono, stage, t } from './theme';
import { SCENE_META } from './meta';

// Four prompts arrive one after another. Each one lights the rung it routes to, and two running totals compare the
// session on AutoMode with the same session on Opus. The per-step costs are the benchmark's: a question $0.008 against
// $0.050 on Opus, a coding task $0.193 against $0.364.
const STEPS = [
  { prompt: 'What does the -r flag do in cp?', model: 'Haiku', effort: 'Low', why: 'a quick fact', auto: 0.008, opus: 0.05 },
  { prompt: 'Rename getUser to fetchUser and update its tests', model: 'Sonnet', effort: 'Medium', why: 'a clear edit, with a test', auto: 0.193, opus: 0.364 },
  { prompt: 'Which file holds the retry policy?', model: 'Haiku', effort: 'Low', why: 'a lookup', auto: 0.008, opus: 0.05 },
  { prompt: 'Move sessions from cookies to signed JWTs', model: 'Opus', effort: 'High', why: 'risk floor: security and migration', auto: 0.364, opus: 0.364 },
] as const;
const RUNGS = [
  ['T0', 'Haiku', 'low'],
  ['T1', 'Sonnet', 'medium'],
  ['T2', 'Sonnet', 'high'],
  ['T3', 'Opus', 'high'],
  ['T4', 'Opus', 'max'],
] as const;
const RUNG_OF = [0, 1, 0, 3];
export const STEP = 75;
// meta.ts holds the length: STEPS.length * STEP plus a 3 second hold on the result.
export const ROUTE_DEMO_FRAMES = SCENE_META['route-demo'].frames;

function Prompt({ text }: { text: string }) {
  const frame = useCurrentFrame();
  const shown = Math.round(interpolate(frame, [0, 24], [0, text.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 26,
        padding: '18px 22px',
        borderRadius: 14,
        border: `1px solid ${C.line}`,
        background: C.panel,
        opacity: t(frame, 0, 8),
        translate: `0px ${interpolate(t(frame, 0, 10), [0, 1], [16, 0])}px`,
      }}
    >
      <span style={{ color: C.muted }}>› </span>
      {text.slice(0, shown)}
      <span style={{ opacity: frame % 20 < 10 && shown < text.length ? 1 : 0, color: C.cyan }}>▌</span>
    </div>
  );
}

function Verdict({ model, effort, why }: { model: keyof typeof MODEL; effort: string; why: string }) {
  const frame = useCurrentFrame();
  const p = t(frame, 0, 14);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 18, opacity: p, translate: `${interpolate(p, [0, 1], [-12, 0])}px 0px` }}>
      <span style={{ padding: '8px 14px', borderRadius: 999, background: MODEL[model], color: C.bg, fontWeight: 800, fontSize: 22 }}>
        {effort} · {model}
      </span>
      <span style={{ color: C.muted, fontSize: 22, fontStyle: 'italic' }}>{why}</span>
    </div>
  );
}

function Ladder() {
  const frame = useCurrentFrame();
  const i = Math.min(STEPS.length - 1, Math.floor(frame / STEP));
  const local = frame - i * STEP;
  const active = local >= 28 ? RUNG_OF[i] : -1;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 250 }}>
      {RUNGS.map(([tier, model, effort], n) => {
        const on = n === active;
        const lift = on ? t(local, 28, 42) : 0;
        return (
          <div
            key={tier}
            style={{
              width: 128,
              height: 90 + n * 36,
              borderRadius: 14,
              border: `1px solid ${on ? MODEL[model] : C.line}`,
              borderTop: `4px solid ${MODEL[model]}`,
              background: on ? `color-mix(in srgb, ${MODEL[model]} 18%, ${C.panel})` : C.panel,
              padding: 14,
              translate: `0px ${-lift * 10}px`,
              boxShadow: on ? `0 18px 50px -12px ${MODEL[model]}` : 'none',
            }}
          >
            <div style={{ fontFamily: mono, fontSize: 15, color: MODEL[model] }}>{tier}</div>
            <div style={{ fontWeight: 700, fontSize: 21 }}>{model}</div>
            <div style={{ fontSize: 15, color: C.muted }}>{effort} effort</div>
          </div>
        );
      })}
    </div>
  );
}

function Totals() {
  const frame = useCurrentFrame();
  const sum = (k: 'auto' | 'opus') =>
    STEPS.reduce((a, s, n) => a + s[k] * t(frame, n * STEP + 30, n * STEP + 50), 0);
  const auto = sum('auto');
  const opus = sum('opus');
  const max = STEPS.reduce((a, s) => a + s.opus, 0);
  const bar = (v: number, color: string, label: string) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 20, marginBottom: 8 }}>
        <span style={{ color: C.muted }}>{label}</span>
        <span style={{ fontFamily: mono, fontWeight: 600 }}>${v.toFixed(3)}</span>
      </div>
      <div style={{ height: 12, borderRadius: 99, background: C.line, overflow: 'hidden' }}>
        <div style={{ width: `${(v / max) * 100}%`, height: '100%', background: color, borderRadius: 99 }} />
      </div>
    </div>
  );
  const end = t(frame, STEPS.length * STEP, STEPS.length * STEP + 20);
  return (
    <div style={{ width: 380, padding: 26, borderRadius: 20, border: `1px solid ${C.line}`, background: 'rgba(17,21,43,0.85)' }}>
      <div style={{ fontSize: 16, letterSpacing: 2, textTransform: 'uppercase', color: C.cyan, fontWeight: 700, marginBottom: 18 }}>This session</div>
      {bar(auto, `linear-gradient(90deg, ${C.violet}, ${C.cyan})`, 'AutoMode')}
      {bar(opus, '#5b6290', 'Claude Code on Opus')}
      <div style={{ marginTop: 6, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {STEPS.map((s, n) => {
          const p = t(frame, n * STEP + 30, n * STEP + 44);
          return (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 16, opacity: p }}>
              <span style={{ width: 10, height: 10, borderRadius: 99, background: MODEL[s.model] }} />
              <span style={{ flex: 1, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.prompt}</span>
              <span style={{ fontFamily: mono, color: MODEL[s.model] }}>{s.model}</span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 8, opacity: end, scale: interpolate(end, [0, 1], [0.9, 1]) }}>
        <span style={{ fontSize: 44, fontWeight: 800, color: C.green }}>{Math.round((1 - auto / Math.max(opus, 0.0001)) * 100)}% less</span>
        <div style={{ color: C.muted, fontSize: 17 }}>In the benchmark's mixed sessions: 51% less</div>
      </div>
    </div>
  );
}

export const RouteDemo: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ ...stage, padding: 56 }}>
      <div style={{ fontSize: 18, letterSpacing: 3, textTransform: 'uppercase', color: C.violet, fontWeight: 700 }}>AutoMode for Claude Code</div>
      <div style={{ fontSize: 40, fontWeight: 800, marginTop: 6 }}>The right model and effort for every prompt</div>
      <div style={{ display: 'flex', gap: 40, marginTop: 34, flex: 1 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div style={{ height: 150 }}>
            {STEPS.map((s, n) => (
              <Sequence key={n} from={n * STEP} durationInFrames={n === STEPS.length - 1 ? STEP + 3 * fps : STEP} layout="none">
                <Prompt text={s.prompt} />
                <Sequence from={28} layout="none">
                  <Verdict model={s.model} effort={s.effort} why={s.why} />
                </Sequence>
              </Sequence>
            ))}
          </div>
          <Ladder />
        </div>
        <Totals />
      </div>
      <div style={{ position: 'absolute', left: 56, bottom: 22, fontSize: 15, color: C.muted }}>
        An illustration. Each step costs the benchmark's average for its kind and model.
      </div>
    </AbsoluteFill>
  );
};
