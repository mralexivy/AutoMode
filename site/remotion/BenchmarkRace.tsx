import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, mono, stage, t } from './theme';
import { SCENE_META } from './meta';

// The mixed-session totals from bench/results/headline.json, split into questions and coding tasks. The bars grow
// together, then each total and its pass count lands.
const ARMS = [
  { who: 'AutoMode', q: 0.08, c: 1.93, total: '$2.01', win: true },
  { who: 'Sonnet high', q: 0.24, c: 1.9, total: '$2.14' },
  { who: 'effortless, on Opus', q: 0.43, c: 3.44, total: '$3.87' },
  { who: 'Claude Code on Opus', q: 0.5, c: 3.64, total: '$4.14' },
];
const MAX = 4.14;
export const BENCHMARK_FRAMES = SCENE_META['benchmark-race'].frames;

export const BenchmarkRace: React.FC = () => {
  const frame = useCurrentFrame();
  const grow = t(frame, 20, 110);
  const badge = t(frame, 150, 175);
  return (
    <AbsoluteFill style={{ ...stage, padding: 64 }}>
      <div style={{ fontSize: 18, letterSpacing: 3, textTransform: 'uppercase', color: C.cyan, fontWeight: 700, opacity: t(frame, 0, 12) }}>
        Five mixed sessions · 20 steps · hidden tests
      </div>
      <div style={{ fontSize: 46, fontWeight: 800, marginTop: 8, opacity: t(frame, 4, 18) }}>Half the cost of Opus. Every step passes.</div>
      <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 22 }}>
        {ARMS.map((a, n) => {
          const show = t(frame, 10 + n * 6, 26 + n * 6);
          const land = t(frame, 110 + n * 8, 128 + n * 8);
          return (
            <div key={a.who} style={{ display: 'grid', gridTemplateColumns: '290px 1fr 130px 90px', alignItems: 'center', gap: 22, opacity: show }}>
              <span style={{ fontSize: 26, fontWeight: a.win ? 800 : 500 }}>{a.who}</span>
              <div style={{ height: 30, borderRadius: 99, background: C.panel, border: `1px solid ${C.line}`, overflow: 'hidden', display: 'flex' }}>
                <div style={{ width: `${(a.q / MAX) * 100 * grow}%`, background: C.cyan }} />
                <div style={{ width: `${(a.c / MAX) * 100 * grow}%`, background: a.win ? `linear-gradient(90deg, ${C.violet}, #c4b5fd)` : '#4a5080' }} />
              </div>
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 30,
                  fontWeight: 600,
                  textAlign: 'right',
                  color: a.win ? C.cyan : C.text,
                  opacity: land,
                  translate: `0px ${interpolate(land, [0, 1], [10, 0])}px`,
                }}
              >
                {a.total}
              </span>
              <span style={{ fontSize: 22, color: C.green, opacity: land }}>20/20</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 28, marginTop: 26, fontSize: 18, color: C.muted, opacity: show(frame) }}>
        <span>
          <span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: 99, background: C.cyan, marginRight: 8 }} />
          questions
        </span>
        <span>
          <span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: 99, background: C.violet, marginRight: 8 }} />
          coding tasks
        </span>
        <span>List-price cost of every request, judges and subagents included</span>
      </div>
      <div style={{ display: 'flex', gap: 24, marginTop: 40 }}>
        {[
          ['−84%', 'on questions', '$0.08 for ten on AutoMode, against $0.50 on Opus'],
          ['29/30', 'single coding tasks', '$0.275 per passed task, against $0.499 on Opus'],
          ['0.551', 'cost ratio against Opus', 'Ship rule fixed before the run: 0.85 or less'],
        ].map(([big, label, note], n) => {
          const p = t(frame, 160 + n * 8, 178 + n * 8);
          return (
            <div
              key={label}
              style={{ flex: 1, padding: '18px 22px', borderRadius: 18, border: `1px solid ${C.line}`, background: C.panel, opacity: p, translate: `0px ${interpolate(p, [0, 1], [14, 0])}px` }}
            >
              <div style={{ fontSize: 34, fontWeight: 800, color: C.cyan }}>{big}</div>
              <div style={{ fontSize: 19, fontWeight: 600, marginTop: 2 }}>{label}</div>
              <div style={{ fontSize: 16, color: C.muted, marginTop: 4 }}>{note}</div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: 'absolute',
          right: 64,
          top: 60,
          padding: '16px 26px',
          borderRadius: 20,
          background: 'linear-gradient(100deg, #a78bfa, #22d3ee)',
          color: C.bg,
          fontSize: 44,
          fontWeight: 800,
          opacity: badge,
          scale: interpolate(badge, [0, 1], [0.7, 1]),
          rotate: `${interpolate(badge, [0, 1], [-6, -3])}deg`,
        }}
      >
        −51%
      </div>
    </AbsoluteFill>
  );
};

const show = (frame: number) => t(frame, 60, 80);
