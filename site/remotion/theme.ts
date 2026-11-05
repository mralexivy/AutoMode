import { loadFont } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { Easing, interpolate } from 'remotion';

// The look every AutoMode scene shares: the site's dark palette, Inter, and one easing curve.
export const { fontFamily } = loadFont('normal', { weights: ['400', '600', '700', '800'], subsets: ['latin'] });
export const { fontFamily: mono } = loadMono('normal', { weights: ['400', '600'], subsets: ['latin'] });

export const C = {
  bg: '#0a0d1b',
  panel: '#11152b',
  line: '#262c52',
  text: '#eef0fb',
  muted: '#a2a9cb',
  cyan: '#22d3ee',
  violet: '#a78bfa',
  green: '#34d399',
  amber: '#fbbf24',
  pink: '#f472b6',
};
export const MODEL = { Haiku: C.green, Sonnet: C.cyan, Opus: C.violet } as const;

export const ease = Easing.bezier(0.16, 1, 0.3, 1);
// A clamped 0 to 1 progress between two frames, eased.
export const t = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });

export { FPS, H, W } from './timing';

export const stage: React.CSSProperties = {
  backgroundColor: C.bg,
  backgroundImage:
    'radial-gradient(900px 420px at 80% -10%, rgba(139,92,246,0.22), transparent 70%), radial-gradient(700px 380px at 0% 110%, rgba(34,211,238,0.12), transparent 70%)',
  color: C.text,
  fontFamily,
  textAlign: 'left',
};
