import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { SCENE_META } from './meta';
import { C, fontFamily, mono, t } from './theme';

// A Claude Code session in a terminal, drawn like the real UI in docs/readme/session.png. Three prompts: a quick
// question on Haiku, an edit on Sonnet with its tools and tests, and a risky migration that the risk floor moves to
// Opus with a review. Each prompt shows the AutoMode bar deciding, then the route it took. The replies are written
// for this scene; the bar's layout and wording are AutoMode's.
export const TERMINAL_FRAMES = SCENE_META['terminal-demo'].frames;

const T = { bg: '#0d1117', fg: '#e6e9f5', dim: '#7d8590', faint: '#4b5263', yellow: '#e3b341', sel: '#2d333b', ok: '#3fb950', blue: '#79c0ff' };

type Line = { text: string; color?: string; bold?: boolean; indent?: number };
type Turn = {
  prompt: string;
  out: Line[];
  verb: string;
  secs: number;
  bar: { model: string; effort: string; up?: boolean; ctx: string; cost: string; why: string };
  status: string;
};

const TURNS: Turn[] = [
  {
    prompt: 'what does the -r flag do in cp? one short sentence',
    out: [{ text: '● It copies directories recursively, with all their contents and subdirectories.' }],
    verb: 'Cooked',
    secs: 4,
    bar: { model: 'Haiku 5.5', effort: 'Low', ctx: '3%', cost: '$0.00', why: 'Quick factual question, no tools needed' },
    status: 'haiku low · lookup',
  },
  {
    prompt: 'rename getUser to fetchUser across the package and update the tests',
    out: [
      { text: '● Search(pattern: "getUser")', color: T.fg, bold: true },
      { text: '⎿  Found 6 files', color: T.dim, indent: 2 },
      { text: '● Update(src/users.ts)', bold: true },
      { text: '⎿  Updated with 4 changes', color: T.dim, indent: 2 },
      { text: '● Bash(npm test)', bold: true },
      { text: '⎿  ✓ 42 tests passed', color: T.ok, indent: 2 },
      { text: '● Renamed in 6 files. All 42 tests pass.' },
    ],
    verb: 'Worked',
    secs: 18,
    bar: { model: 'Sonnet 5.5', effort: 'Medium', up: true, ctx: '9%', cost: '$0.19', why: 'Clear edit across files, tests to run' },
    status: 'sonnet medium · edit',
  },
  {
    prompt: 'migrate the session store from cookies to signed JWTs with key rotation',
    out: [
      { text: '● 1. Provision signing keys and add kid headers.' },
      { text: '  2. Issue short-lived JWTs beside sessions; accept both.' },
      { text: '  3. Add refresh tokens and a revocation denylist.' },
      { text: '  4. Rotate keys on a schedule; keep old verify keys.' },
      { text: '● Independent review: no blockers found.', color: T.ok },
    ],
    verb: 'Sautéed',
    secs: 41,
    bar: { model: 'Opus 5.5', effort: 'High', up: true, ctx: '14%', cost: '$0.58', why: 'floor T3: security and migration' },
    status: 'opus high · review passed',
  },
];

// Frames inside one turn: type the prompt, decide, stream the reply, settle.
const TYPE = 36;
const DECIDE = 22;
const LINE = 9;
const HOLD = 34;
const lenOf = (turn: Turn) => TYPE + DECIDE + turn.out.length * LINE + HOLD;
const START = TURNS.reduce<number[]>((a, turn, n) => [...a, n ? a[n - 1] + lenOf(TURNS[n - 1]) : 18], []);

function Bar({ turn, deciding, appear }: { turn: Turn; deciding: boolean; appear: number }) {
  const b = turn.bar;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        border: `1px solid ${T.faint}`,
        borderRadius: 6,
        padding: '8px 14px',
        margin: '14px 0 6px 6px',
        width: 960,
        opacity: appear,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <span style={{ color: C.violet }}>✦</span>
      {deciding ? (
        <span style={{ color: T.dim }}>Deciding…</span>
      ) : (
        <>
          <b>{b.model}</b>
          <span style={{ color: T.faint }}>·</span>
          <span>{b.effort}</span>
          {b.up ? <span style={{ color: T.yellow }}>↑</span> : null}
          <span style={{ color: T.faint }}>·</span>
          <span>{b.ctx}</span>
          <span style={{ color: T.faint }}>·</span>
          <span style={{ color: T.dim }}>cache 59m</span>
          <span style={{ color: T.faint }}>·</span>
          <b>{b.cost}</b>
          <span style={{ color: T.dim, overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>— {b.why}</span>
          <span>
            <span style={{ color: C.cyan }}>m:</span> ● on
          </span>
        </>
      )}
    </div>
  );
}

function Exchange({ turn, local }: { turn: Turn; local: number }) {
  const typed = Math.round(interpolate(local, [0, TYPE - 6], [0, turn.prompt.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const sent = local >= TYPE;
  const decided = local >= TYPE + DECIDE;
  const lines = Math.max(0, Math.floor((local - TYPE - DECIDE) / LINE) + 1);
  return (
    <div style={{ marginBottom: 18 }}>
      <div>
        <span style={{ background: sent ? T.sel : 'transparent', padding: '1px 4px' }}>
          <span style={{ color: T.dim }}>❯ </span>
          {turn.prompt.slice(0, typed)}
        </span>
        {!sent ? <span style={{ color: T.fg, opacity: local % 16 < 8 ? 1 : 0 }}>▌</span> : null}
      </div>
      {sent ? <Bar turn={turn} deciding={!decided} appear={t(local, TYPE, TYPE + 6)} /> : null}
      {decided
        ? turn.out.slice(0, lines).map((l, n) => (
            <div
              key={n}
              style={{
                color: l.color ?? T.fg,
                fontWeight: l.bold ? 600 : 400,
                paddingLeft: (l.indent ?? 0) * 12,
                opacity: t(local, TYPE + DECIDE + n * LINE, TYPE + DECIDE + n * LINE + 5),
                whiteSpace: 'pre',
              }}
            >
              {l.text}
            </div>
          ))
        : null}
      {lines > turn.out.length ? (
        <div style={{ color: T.dim, marginTop: 8 }}>
          ✻ {turn.verb} for {turn.secs}s · done 5:11 PM
        </div>
      ) : null}
    </div>
  );
}

export const TerminalDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const current = Math.max(0, START.filter((s) => frame >= s).length - 1);
  const shown = TURNS.slice(0, current + 1);
  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(900px 500px at 80% -10%, rgba(139,92,246,0.35), transparent 70%), radial-gradient(700px 420px at 0% 110%, rgba(34,211,238,0.22), transparent 70%), #0a0d1b',
        padding: 36,
        fontFamily,
        textAlign: 'left',
      }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: T.bg,
          borderRadius: 14,
          border: '1px solid #30363d',
          boxShadow: '0 40px 100px -30px rgba(70,50,200,0.75)',
          overflow: 'hidden',
          opacity: t(frame, 0, 10),
          scale: interpolate(t(frame, 0, 14), [0, 1], [0.97, 1]),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid #21262d', background: '#161b22' }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
            <span key={c} style={{ width: 12, height: 12, borderRadius: 99, background: c }} />
          ))}
          <span style={{ flex: 1, textAlign: 'center', color: T.dim, fontSize: 15, marginRight: 52 }}>~/acme-api — claude</span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden', padding: '18px 26px 0', fontFamily: mono, fontSize: 19, lineHeight: 1.5, color: T.fg }}>
          {shown.map((turn, n) => (
            <Exchange key={n} turn={turn} local={frame - START[n]} />
          ))}
          <div style={{ borderTop: `1px solid ${T.faint}`, borderBottom: `1px solid ${T.faint}`, padding: '6px 0', marginTop: 6, color: T.dim }}>❯</div>
          <div style={{ padding: '6px 4px 14px', color: T.yellow }}>
            <div>⚠ automode: AutoMode · {TURNS[current].status}</div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// meta.ts must hold this length. tests/site.test.mts checks the numbers that make it up.
export const TERMINAL_LENGTH = START[START.length - 1] + lenOf(TURNS[TURNS.length - 1]) + 30;
