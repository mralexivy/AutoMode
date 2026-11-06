import { loadFont } from '@remotion/google-fonts/BricolageGrotesque';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';
import { C, MODEL, mono, t } from '../theme';

// The social cut: one 4:5 video for Reddit, X, LinkedIn and Bluesky. It shows what AutoMode does in a session first,
// then the agents, then the benchmark, then the install commands. The benchmark totals are the five mixed sessions in
// bench/results/headline.json.
const { fontFamily: display } = loadFont('normal', { weights: ['600', '800'], subsets: ['latin'] });

export const SOCIAL_W = 1080;
export const SOCIAL_H = 1350;
const ACT = { title: [0, 150], route: [150, 400], team: [400, 560], bench: [560, 700], cta: [700, 800] } as const;
export const SOCIAL_FRAMES = 800;

const ink = '#0d0b1f';
const panel = '#17142e';
const line = '#2c2752';
const soft = '#9b94c4';

const bg: React.CSSProperties = {
  backgroundColor: ink,
  backgroundImage:
    'radial-gradient(820px 560px at 88% 6%, rgba(167,139,250,0.22), transparent 62%), radial-gradient(640px 480px at 0% 100%, rgba(34,211,238,0.12), transparent 62%)',
  color: C.text,
  fontFamily: display,
  padding: '84px 78px',
};

const fade = (frame: number, len: number) => Math.min(t(frame, 0, 12), 1 - t(frame, len - 12, len));

function Mark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontWeight: 600, fontSize: 30, color: soft }}>
      <div style={{ width: 34, height: 34, borderRadius: 10, background: `conic-gradient(from 210deg, ${C.green}, ${C.cyan}, ${C.violet}, ${C.green})` }} />
      AutoMode for Claude Code
    </div>
  );
}

function Headline({ top, bottom, size = 96 }: { top: React.ReactNode; bottom: string; size?: number }) {
  const frame = useCurrentFrame();
  const a = t(frame, 0, 18);
  const b = t(frame, 10, 30);
  return (
    <div style={{ marginTop: 48, fontWeight: 800, fontSize: size, lineHeight: 1, letterSpacing: '-0.035em' }}>
      <div style={{ opacity: a, translate: `0px ${interpolate(a, [0, 1], [24, 0])}px` }}>{top}</div>
      <div style={{ color: soft, fontWeight: 600, opacity: b, translate: `0px ${interpolate(b, [0, 1], [24, 0])}px` }}>{bottom}</div>
    </div>
  );
}

function Title() {
  const frame = useCurrentFrame();
  const len = ACT.title[1] - ACT.title[0];
  const strike = t(frame, 70, 95);
  return (
    <AbsoluteFill style={{ ...bg, opacity: fade(frame, len) }}>
      <Mark />
      <div style={{ marginTop: 'auto', marginBottom: 'auto' }}>
        <div style={{ fontWeight: 800, fontSize: 132, lineHeight: 0.98, letterSpacing: '-0.04em' }}>
          Stop picking{' '}
          <span style={{ position: 'relative', fontFamily: mono, fontWeight: 600 }}>
            /model
            <span style={{ position: 'absolute', left: 0, top: '54%', height: 10, width: `${strike * 100}%`, background: C.amber, borderRadius: 6 }} />
          </span>
        </div>
        <div style={{ marginTop: 36, fontSize: 54, fontWeight: 600, color: soft, lineHeight: 1.15, opacity: t(frame, 95, 115) }}>
          AutoMode picks the model and the effort for every prompt.
        </div>
      </div>
    </AbsoluteFill>
  );
}

const ROUTES = [
  { prompt: 'what does -r do in cp?', model: 'Haiku', effort: 'low', why: 'a quick fact' },
  { prompt: 'rename getUser to fetchUser everywhere', model: 'Sonnet', effort: 'medium', why: 'a clear edit' },
  { prompt: 'move sessions from cookies to signed JWTs', model: 'Opus', effort: 'high', why: 'risk floor: security' },
] as const;
const EACH = 70;

function RouteRow({ r }: { r: (typeof ROUTES)[number] }) {
  const frame = useCurrentFrame();
  const shown = Math.round(interpolate(frame, [0, 26], [0, r.prompt.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const wire = t(frame, 26, 40);
  const chip = t(frame, 38, 52);
  const color = MODEL[r.model];
  return (
    <div style={{ marginTop: 30 }}>
      <div style={{ background: panel, border: `1px solid ${line}`, borderRadius: 22, padding: '26px 30px', fontFamily: mono, fontSize: 30, opacity: t(frame, 0, 8) }}>
        <span style={{ color: soft }}>❯ </span>
        {r.prompt.slice(0, shown)}
        <span style={{ color: C.cyan, opacity: shown < r.prompt.length && frame % 16 < 8 ? 1 : 0 }}>▌</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 16, paddingLeft: 30 }}>
        <div style={{ width: 90 * wire, height: 4, borderRadius: 4, background: color }} />
        <div style={{ opacity: chip, translate: `${interpolate(chip, [0, 1], [-16, 0])}px 0px`, display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ background: color, color: ink, fontWeight: 800, fontSize: 34, padding: '10px 22px', borderRadius: 999 }}>{r.model}</span>
          <span style={{ fontFamily: mono, fontSize: 26, color: C.text }}>{r.effort} effort</span>
          <span style={{ fontSize: 26, color: soft, fontStyle: 'italic' }}>· {r.why}</span>
        </div>
      </div>
    </div>
  );
}

function Route() {
  const frame = useCurrentFrame();
  const len = ACT.route[1] - ACT.route[0];
  const bar = t(frame, 3 * EACH, 3 * EACH + 16);
  return (
    <AbsoluteFill style={{ ...bg, opacity: fade(frame, len) }}>
      <Mark />
      <Headline top="One prompt, one route." bottom="Picked fresh every time." size={84} />
      <div style={{ marginTop: 34 }}>
        {ROUTES.map((r, i) => (
          <Sequence key={r.prompt} from={i * EACH} layout="none">
            <RouteRow r={r} />
          </Sequence>
        ))}
      </div>
      <div style={{ marginTop: 'auto', opacity: bar, border: '2px solid #5b5394', borderRadius: 18, padding: '22px 26px', fontFamily: mono, fontSize: 27, background: '#120f26' }}>
        <span style={{ color: C.violet, fontWeight: 600 }}>✦ Opus 5.5</span>
        <span style={{ color: '#57508a' }}> · </span>High ↑<span style={{ color: '#57508a' }}> · </span>14%<span style={{ color: '#57508a' }}> · </span>cache 59m
        <div style={{ color: soft, marginTop: 8 }}>— the bar shows every route and why</div>
      </div>
    </AbsoluteFill>
  );
}

const TEAM = [
  ['Discover', 'explorers read the code', 'Haiku'],
  ['Plan', 'an architect splits the work', 'Opus'],
  ['Build', 'implementers own their files', 'Sonnet'],
  ['Verify', 'exit codes decide', 'Sonnet'],
  ['Review', 'an independent reviewer', 'Opus'],
] as const;

function Team() {
  const frame = useCurrentFrame();
  const len = ACT.team[1] - ACT.team[0];
  return (
    <AbsoluteFill style={{ ...bg, opacity: fade(frame, len) }}>
      <Mark />
      <Headline top="Big jobs get a team" bottom="of specialized subagents." size={84} />
      <div style={{ marginTop: 44, display: 'grid', gap: 16 }}>
        {TEAM.map(([n, d, m], i) => {
          const p = t(frame, 18 + i * 16, 34 + i * 16);
          const color = MODEL[m];
          return (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 22, background: panel, border: `1px solid ${p > 0.99 ? color : line}`, borderRadius: 20, padding: '22px 28px', opacity: 0.25 + 0.75 * p }}>
              <span style={{ fontWeight: 800, fontSize: 40, width: 200 }}>{n}</span>
              <span style={{ fontSize: 27, color: soft, flex: 1 }}>{d}</span>
              <span style={{ fontFamily: mono, fontWeight: 600, fontSize: 24, background: color, color: ink, padding: '8px 18px', borderRadius: 999 }}>{m}</span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 40, border: `2px solid ${C.amber}`, borderRadius: 20, padding: '22px 28px', fontSize: 30, lineHeight: 1.3, opacity: t(frame, 110, 126) }}>
        <b style={{ color: C.amber }}>Risk floor in code.</b> Auth and migrations never land on a small model.
      </div>
    </AbsoluteFill>
  );
}

const BENCH = [
  ['AutoMode', 2.01, true],
  ['Sonnet high', 2.14, false],
  ['effortless, Opus', 3.87, false],
  ['Claude Code, Opus', 4.14, false],
] as const;

function Bench() {
  const frame = useCurrentFrame();
  const len = ACT.bench[1] - ACT.bench[0];
  const grow = t(frame, 20, 80);
  return (
    <AbsoluteFill style={{ ...bg, opacity: fade(frame, len) }}>
      <Mark />
      <Headline top="Cheapest of the four." bottom="Every step still passes." size={88} />
      <div style={{ marginTop: 64, display: 'grid', gap: 30 }}>
        {BENCH.map(([name, usd, win]) => (
          <div key={name} style={{ display: 'grid', gridTemplateColumns: '300px 1fr 150px', alignItems: 'center', gap: 22, fontSize: 32 }}>
            <span style={{ fontWeight: win ? 800 : 600 }}>{name}</span>
            <div style={{ height: 50, background: '#1b1838', borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(usd / 4.14) * 100 * grow}%`, borderRadius: 14, background: win ? `linear-gradient(90deg, ${C.green}, ${C.cyan} 45%, ${C.violet})` : '#4a4479' }} />
            </div>
            <span style={{ fontFamily: mono, fontWeight: 600, fontSize: 38, textAlign: 'right', color: win ? C.green : C.text, opacity: t(frame, 70, 86) }}>${usd.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 56, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
        {[['−51%', 'against Claude Code on Opus'], ['−48%', 'against effortless']].map(([n, l], i) => (
          <div key={n} style={{ background: panel, border: `1px solid ${line}`, borderRadius: 22, padding: '28px 30px', opacity: t(frame, 84 + i * 8, 100 + i * 8) }}>
            <div style={{ fontWeight: 800, fontSize: 76, letterSpacing: '-0.03em', color: C.green }}>{n}</div>
            <div style={{ fontSize: 27, color: soft, marginTop: 6 }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 'auto', fontSize: 25, lineHeight: 1.4, color: soft, opacity: t(frame, 96, 110) }}>
        Five mixed sessions, 20 steps, each graded by hidden tests. All four passed 20 of 20. On long tasks alone it costs about what Sonnet high costs.
      </div>
    </AbsoluteFill>
  );
}

function Cta() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ ...bg, opacity: t(frame, 0, 12) }}>
      <Mark />
      <div style={{ marginTop: 'auto', marginBottom: 'auto' }}>
        <div style={{ fontWeight: 800, fontSize: 104, lineHeight: 1, letterSpacing: '-0.035em' }}>Free. MIT.</div>
        <div style={{ fontWeight: 600, fontSize: 104, lineHeight: 1, letterSpacing: '-0.035em', color: soft }}>No API key.</div>
        <div style={{ marginTop: 56, background: panel, border: `1px solid ${line}`, borderRadius: 22, padding: '30px 34px', fontFamily: mono, fontSize: 31, lineHeight: 1.7, opacity: t(frame, 14, 28) }}>
          <span style={{ color: soft }}># inside Claude Code</span>
          <br />/plugin marketplace add mralexivy/AutoMode
          <br />/plugin install automode@automode
        </div>
      </div>
      <div style={{ fontSize: 34, fontWeight: 600 }}>github.com/mralexivy/AutoMode</div>
    </AbsoluteFill>
  );
}

export const SocialCut: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: ink }}>
    <Sequence from={ACT.title[0]} durationInFrames={ACT.title[1] - ACT.title[0]}><Title /></Sequence>
    <Sequence from={ACT.route[0]} durationInFrames={ACT.route[1] - ACT.route[0]}><Route /></Sequence>
    <Sequence from={ACT.team[0]} durationInFrames={ACT.team[1] - ACT.team[0]}><Team /></Sequence>
    <Sequence from={ACT.bench[0]} durationInFrames={ACT.bench[1] - ACT.bench[0]}><Bench /></Sequence>
    <Sequence from={ACT.cta[0]} durationInFrames={ACT.cta[1] - ACT.cta[0]}><Cta /></Sequence>
  </AbsoluteFill>
);
