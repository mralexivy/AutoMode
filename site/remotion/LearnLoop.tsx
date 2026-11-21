import { AbsoluteFill } from 'remotion';
import { useCurrentFrame } from 'remotion';
import { C, mono, stage, t } from './theme';
import { SCENE_META } from './meta';

// The learning loop in one project. It starts from the shipped rules. A small share of tasks tries a cheaper start.
// Where the results hold up, the cheaper start is adopted. Where they do not, it is reverted. When the person steps
// away, a learning pass picks what to test next. The loop is AutoMode's; the task counts and results are an example.
export const LEARN_FRAMES = SCENE_META.learns.frames;

type Dot = { ok: boolean };
const DOCS: Dot[] = [true, true, true, true, true, true, true, true, true, true, true, true].map((ok) => ({ ok }));
const COMPLEX: Dot[] = [true, false, true, false, false, true, false, true, false, false, true, false].map((ok) => ({ ok }));

function Lane({ title, sub, dots, at, verdict, verdictAt, color }: { title: string; sub: string; dots: Dot[]; at: number; verdict: string; verdictAt: number; color: string }) {
  const frame = useCurrentFrame();
  return (
    <div style={{ flex: 1, padding: 24, borderRadius: 20, border: `1px solid ${C.line}`, background: 'rgba(17,21,43,0.85)' }}>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 17, color: C.muted, marginTop: 4 }}>{sub}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 22, minHeight: 84 }}>
        {dots.map((d, i) => {
          const p = t(frame, at + i * 4, at + i * 4 + 10);
          return <div key={i} style={{ width: 34, height: 34, borderRadius: 10, opacity: p, scale: String(0.6 + 0.4 * p), background: d.ok ? C.green : C.pink }} />;
        })}
      </div>
      <div style={{ marginTop: 22, fontFamily: mono, fontSize: 26, fontWeight: 600, color, opacity: t(frame, verdictAt, verdictAt + 14) }}>{verdict}</div>
    </div>
  );
}

export const LearnLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const away = t(frame, 196, 212);
  return (
    <AbsoluteFill style={{ ...stage, padding: 64 }}>
      <div style={{ fontSize: 18, letterSpacing: 3, textTransform: 'uppercase', color: C.cyan, fontWeight: 700 }}>It learns you</div>
      <div style={{ fontSize: 44, fontWeight: 800, marginTop: 8 }}>Tested rules first, then your own results</div>
      <div style={{ fontSize: 22, color: C.muted, marginTop: 14, opacity: t(frame, 8, 22) }}>
        One in seven tasks tries a cheaper start. Each kind of task keeps it only if the results hold up.
      </div>
      <div style={{ display: 'flex', gap: 32, marginTop: 36 }}>
        <Lane title="Docs edits" sub="Haiku start, 12 tasks" dots={DOCS} at={30} verdict="Adopted" verdictAt={96} color={C.green} />
        <Lane title="Complex refactors" sub="Haiku start, 12 tasks" dots={COMPLEX} at={60} verdict="Reverted" verdictAt={126} color={C.pink} />
      </div>
      <div
        style={{
          marginTop: 28,
          padding: 22,
          borderRadius: 18,
          border: `1px solid ${away > 0.5 ? C.violet : C.line}`,
          background: C.panel,
          fontSize: 23,
          opacity: t(frame, 150, 166),
        }}
      >
        {away > 0.5 ? (
          <span>
            <b style={{ color: C.violet }}>You step away:</b> a learning pass reviews the week and picks the next kind of task to test. One short Haiku call, about a tenth of a cent.
          </span>
        ) : (
          <span>
            <b style={{ color: C.cyan }}>Safety first:</b> risk floors, your /model and /effort, and critical work are never part of a test.
          </span>
        )}
      </div>
      <div style={{ position: 'absolute', left: 64, bottom: 24, fontSize: 15, color: C.muted }}>The loop is AutoMode's. The task counts and results are an example.</div>
    </AbsoluteFill>
  );
};
