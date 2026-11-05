import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, mono, stage, t } from './theme';
import { SCENE_META } from './meta';

// The switch check from hooks/lib/policy.ts, in one chat. The context grows warm on Sonnet. A cheaper model is
// proposed, its saving is weighed against the cache rewrite, and the route holds. Then a risk floor arrives and the
// switch goes through, whatever it costs. The rule is real; the token counts are an example.
export const CACHE_FRAMES = SCENE_META['cache-check'].frames;

function Row({ label, value, color, at }: { label: string; value: string; color: string; at: number }) {
  const frame = useCurrentFrame();
  const p = t(frame, at, at + 14);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, padding: '12px 0', borderBottom: `1px solid ${C.line}`, opacity: p }}>
      <span style={{ color: C.muted }}>{label}</span>
      <span style={{ fontFamily: mono, fontWeight: 600, color, whiteSpace: 'nowrap', marginLeft: 16 }}>{value}</span>
    </div>
  );
}

export const CacheCheck: React.FC = () => {
  const frame = useCurrentFrame();
  const tokens = Math.round(interpolate(frame, [10, 80], [4, 86], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const hold = t(frame, 150, 166);
  const floor = t(frame, 200, 216);
  const sw = t(frame, 232, 250);
  return (
    <AbsoluteFill style={{ ...stage, padding: 64 }}>
      <div style={{ fontSize: 18, letterSpacing: 3, textTransform: 'uppercase', color: C.cyan, fontWeight: 700 }}>The switch check</div>
      <div style={{ fontSize: 44, fontWeight: 800, marginTop: 8 }}>A model switch must pay for its cache rewrite</div>
      <div style={{ display: 'flex', gap: 48, marginTop: 44 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 20, color: C.muted, marginBottom: 10 }}>Warm chat on Sonnet</div>
          <div style={{ height: 26, borderRadius: 99, background: C.panel, border: `1px solid ${C.line}`, overflow: 'hidden' }}>
            <div style={{ width: `${tokens}%`, height: '100%', background: `linear-gradient(90deg, ${C.cyan}, ${C.violet})` }} />
          </div>
          <div style={{ fontFamily: mono, fontSize: 22, marginTop: 10 }}>{tokens}k tokens cached</div>
          <div
            style={{
              marginTop: 40,
              padding: 22,
              borderRadius: 18,
              border: `1px solid ${floor > 0.5 ? C.violet : C.line}`,
              background: C.panel,
              fontSize: 24,
              opacity: t(frame, 90, 104),
            }}
          >
            {floor > 0.5 ? (
              <span>
                <b style={{ color: C.violet }}>Risk floor:</b> the next prompt touches auth. A floor always switches, so it moves to Opus.
              </span>
            ) : (
              <span>
                <b style={{ color: C.green }}>Proposal:</b> the next prompt is small. Move down to Haiku?
              </span>
            )}
          </div>
          <div style={{ marginTop: 22, fontSize: 19, color: C.muted, lineHeight: 1.6, opacity: t(frame, 60, 76) }}>
            Moving up needs two votes in a row. Moving down in a warm chat needs no risk and confidence of 0.85. After 3 switches in one task, the route holds.
          </div>
        </div>
        <div style={{ width: 560, padding: 26, borderRadius: 20, border: `1px solid ${C.line}`, background: 'rgba(17,21,43,0.85)' }}>
          <Row label="Saving on the next requests" value="≈ $0.04" color={C.green} at={104} />
          <Row label="Rewrite 86k tokens into a new cache" value="≈ $0.11" color={C.amber} at={118} />
          <Row label="Rule: saving > 1.5 × rewrite" value={floor > 0.5 ? 'floor wins' : 'fails'} color={floor > 0.5 ? C.violet : C.pink} at={132} />
          <div
            style={{
              marginTop: 26,
              fontSize: 40,
              fontWeight: 800,
              color: floor > 0.5 ? C.violet : C.cyan,
              opacity: Math.max(hold * (1 - floor), sw),
              scale: interpolate(Math.max(hold * (1 - floor), sw), [0, 1], [0.9, 1]),
            }}
          >
            {floor > 0.5 ? 'Switch → Opus' : 'Hold on Sonnet'}
          </div>
          <div style={{ fontSize: 18, color: C.muted, marginTop: 6, opacity: Math.max(hold * (1 - floor), sw) }}>
            {floor > 0.5 ? 'Quality first, whatever the rewrite costs.' : 'Effort can still change. That keeps the cache.'}
          </div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 64, bottom: 24, fontSize: 15, color: C.muted }}>
        The rules are AutoMode's. The token counts and prices are an example.
      </div>
    </AbsoluteFill>
  );
};
