// AutoMode design tokens: one palette per appearance and theme, named for what a colour means. Every drawing in
// hooks/ui takes its colours from here; nothing else holds a hex. tests/ui-view.test.mts checks WCAG contrast for every
// text colour on both surfaces (4.5:1), so a token change that does not read fails the build.
//
// Roles: route (electric blue: the model router), cyan (the routing gradient's far end), effort (violet: reasoning
// effort), guard (teal: the guardian, healthy execution), warn (amber), error (red). Neutrals carry everything else.

export type Appearance = 'dark' | 'light'
export type ThemeName = 'native' | 'automode' | 'mono' | 'contrast'
// native (the default) holds no colour of its own: every role is a Claude Code theme key, which the host resolves in the
// person's own theme (VS Code's, the terminal's). The others are AutoMode palettes, hex, chosen on purpose.
export const THEMES: readonly ThemeName[] = ['native', 'automode', 'mono', 'contrast']
export const PALETTES: readonly ThemeName[] = ['automode', 'mono', 'contrast']
export type Role = 'text' | 'dim' | 'route' | 'cyan' | 'effort' | 'guard' | 'warn' | 'error'
export const TEXT_ROLES: readonly Role[] = ['text', 'dim', 'route', 'cyan', 'effort', 'guard', 'warn', 'error']

export interface Tokens {
  appearance: Appearance
  theme: ThemeName
  bg: string       // the band's surface
  raised: string   // a card or a selected row on the band
  edge: string     // borders and rules
  hover: string    // the hover box behind a control
  text: string
  dim: string
  route: string
  cyan: string
  effort: string
  guard: string
  warn: string
  error: string
  warnBg: string   // an alert card's surface
  errorBg: string
}

const AUTOMODE: Record<Appearance, Tokens> = {
  dark: {
    appearance: 'dark', theme: 'automode',
    bg: '#10141c', raised: '#171c26', edge: '#2a3242', hover: '#1f2633',
    text: '#e8ebf2', dim: '#9aa4b5', route: '#4ea8ff', cyan: '#3fd6ec', effort: '#b39dff', guard: '#34d3bd', warn: '#f5b84a', error: '#ff7a7a',
    warnBg: '#1d1a12', errorBg: '#1f1316',
  },
  light: {
    appearance: 'light', theme: 'automode',
    bg: '#f7f9fc', raised: '#eef2f8', edge: '#d3dae6', hover: '#e6ebf3',
    text: '#141a26', dim: '#5a6476', route: '#0a62c9', cyan: '#0b7285', effort: '#6b3fd4', guard: '#0b7468', warn: '#9a5b00', error: '#c0262d',
    warnBg: '#fbf4e6', errorBg: '#fbeced',
  },
}

// mono: the accents step back to the neutrals; amber and red keep their meaning, since a warning must not depend on a theme.
// contrast: stronger text and edges for low-contrast displays and bright rooms.
const VARIANTS: Record<Exclude<ThemeName, 'automode' | 'native'>, Record<Appearance, Partial<Tokens>>> = {
  mono: {
    dark: { route: '#d5dae3', cyan: '#c2c8d3', effort: '#e8ebf2', guard: '#c2c8d3' },
    light: { route: '#2a3242', cyan: '#3a4356', effort: '#141a26', guard: '#3a4356' },
  },
  contrast: {
    dark: { bg: '#05070b', raised: '#0d1118', edge: '#5b6880', text: '#ffffff', dim: '#c3cad6', route: '#7cc0ff', cyan: '#6fe6f5', effort: '#cdbdff', guard: '#5ee8d3', warn: '#ffcc66', error: '#ff9a9a' },
    light: { bg: '#ffffff', raised: '#f1f4f9', edge: '#8a96aa', text: '#000000', dim: '#3a4356', route: '#004fa8', cyan: '#005866', effort: '#4f22b0', guard: '#005a51', warn: '#7a4700', error: '#9e1a20' },
  },
}

// Status keeps its meaning through the theme's own success, warning and error colours; everything else is text weight and the
// theme's dim text, so nothing is blue unless the person's theme makes it so. Surfaces are left to the host ('').
const NATIVE: Tokens = {
  appearance: 'dark', theme: 'native', bg: '', raised: '', edge: 'promptBorder', hover: '',
  text: 'text', dim: 'subtle', route: 'text', cyan: 'subtle', effort: 'text', guard: 'success', warn: 'warning', error: 'error', warnBg: '', errorBg: '',
}
export const isNative = (t: Tokens) => t.theme === 'native'

export function tokensFor(appearance: Appearance, theme: ThemeName = 'native'): Tokens {
  if (theme === 'native') return { ...NATIVE, appearance }
  const base = AUTOMODE[appearance]
  return theme === 'automode' ? base : { ...base, ...VARIANTS[theme][appearance], theme }
}

// The person's /config theme row ('dark', 'light', 'dark-daltonized', 'light-ansi', ...) to an appearance.
export function appearanceOf(setting: 'auto' | Appearance, configTheme: string | null | undefined): Appearance {
  if (setting !== 'auto') return setting
  return /^light/i.test(String(configTheme ?? '')) ? 'light' : 'dark'
}

// WCAG 2 relative luminance and contrast ratio, for the tests and for the gallery's check.
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16)
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255)
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
