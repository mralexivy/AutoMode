import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, mono, stage, t } from './theme';
import { SCENE_META } from './meta';

// The am:run workflow: each stage lights up in order with its model, a check runs green, and the review gate closes.
const STAGES = [
  { name: 'Risk band', who: 'code', color: C.amber, note: 'S3: security and migration' },
  { name: 'Discover', who: 'Haiku', color: C.green, note: '3 scoped explorers' },
  { name: 'Plan', who: 'Opus', color: C.violet, note: '2 workstreams, 5 criteria' },
  { name: 'Build', who: 'Sonnet', color: C.cyan, note: 'owns its files only' },
  { name: 'Verify', who: 'Sonnet', color: C.cyan, note: 'exit codes decide' },
  { name: 'Review', who: 'Opus', color: C.violet, note: 'mandatory for S3' },
];
const EACH = 32;
// meta.ts holds the length: STAGES.length * EACH plus 80 frames for the result.
export const WORKFLOW_FRAMES = SCENE_META['workflow-flow'].frames;

export const WorkflowFlow: React.FC = () => {
  const frame = useCurrentFrame();
  const done = t(frame, STAGES.length * EACH + 10, STAGES.length * EACH + 30);
  return (
    <AbsoluteFill style={{ ...stage, padding: 64 }}>
      <div style={{ fontFamily: mono, fontSize: 24, color: C.muted, opacity: t(frame, 0, 10) }}>
        <span style={{ color: C.cyan }}>›</span> am:run migrate sessions to signed JWTs
      </div>
      <div style={{ fontSize: 44, fontWeight: 800, marginTop: 14 }}>Big jobs get a real workflow</div>
      <div style={{ position: 'relative', display: 'flex', gap: 18, marginTop: 70 }}>
        <div style={{ position: 'absolute', left: 30, right: 30, top: 44, height: 4, background: C.line, borderRadius: 4 }} />
        <div
          style={{
            position: 'absolute',
            left: 30,
            top: 44,
            height: 4,
            borderRadius: 4,
            background: `linear-gradient(90deg, ${C.amber}, ${C.green}, ${C.violet}, ${C.cyan}, ${C.violet})`,
            width: `${interpolate(frame, [10, STAGES.length * EACH], [0, 95], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}%`,
          }}
        />
        {STAGES.map((s, n) => {
          const on = t(frame, n * EACH + 6, n * EACH + 22);
          return (
            <div key={s.name} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
              <div
                style={{
                  width: 92,
                  height: 92,
                  borderRadius: 999,
                  display: 'grid',
                  placeItems: 'center',
                  background: C.panel,
                  border: `3px solid ${on > 0.5 ? s.color : C.line}`,
                  boxShadow: on > 0.5 ? `0 0 40px -6px ${s.color}` : 'none',
                  scale: interpolate(on, [0, 0.6, 1], [0.85, 1.08, 1]),
                  fontSize: 34,
                  color: s.color,
                  zIndex: 1,
                }}
              >
                {on > 0.9 ? '✓' : n + 1}
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 18, opacity: interpolate(on, [0, 1], [0.4, 1]) }}>{s.name}</div>
              <div style={{ fontFamily: mono, fontSize: 18, color: s.color, marginTop: 4, opacity: on }}>{s.who}</div>
              <div style={{ fontSize: 16, color: C.muted, marginTop: 6, opacity: on }}>{s.note}</div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 70,
          alignSelf: 'center',
          padding: '16px 28px',
          borderRadius: 16,
          border: `1px solid ${C.green}`,
          background: 'rgba(52,211,153,0.1)',
          fontSize: 26,
          fontWeight: 700,
          opacity: done,
          translate: `0px ${interpolate(done, [0, 1], [14, 0])}px`,
        }}
      >
        <span style={{ color: C.green }}>✓</span> Checks pass · review approved · ready to merge
      </div>
    </AbsoluteFill>
  );
};
