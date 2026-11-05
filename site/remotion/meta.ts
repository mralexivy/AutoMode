import { FPS } from './timing';

// The facts about each AutoMode scene that pages and the sitemap need, without the scene code. Each title and
// description is also the scene's VideoObject in structured data. scenes.ts adds the components.
export const SCENE_META = {
  'terminal-demo': {
    frames: 441,
    title: 'AutoMode in a Claude Code terminal session',
    description: 'A Claude Code session with AutoMode: a quick question runs on Haiku at Low, an edit on Sonnet with tests, and a JWT migration moves up to Opus with a review.',
  },
  'route-demo': {
    frames: 375,
    title: 'How AutoMode routes each Claude Code prompt',
    description: 'Four prompts in one Claude Code session. Quick questions go to Haiku, an edit to Sonnet, and a risky migration to Opus, with the running cost against Opus.',
  },
  'benchmark-race': {
    frames: 240,
    title: 'AutoMode benchmark: half the cost of Claude Code on Opus',
    description: 'Five mixed sessions, 20 steps with hidden tests: AutoMode $2.01, Sonnet high $2.14, effortless $3.87 and Opus $4.14, every arm passing 20 of 20.',
  },
  'workflow-flow': {
    frames: 272,
    title: 'The AutoMode workflow: plan, build, verify and review',
    description: 'An am:run job moves through the risk band, Haiku discovery, an Opus plan, a Sonnet build and verify, and a mandatory review for risky work.',
  },
  'cache-check': {
    frames: 300,
    title: 'Does switching Claude models waste the prompt cache?',
    description: 'AutoMode weighs a model switch against its prompt cache rewrite, holds the model when the switch does not pay, and always switches for a risk floor.',
  },
} as const;

export type SceneId = keyof typeof SCENE_META;
export const sceneSeconds = (id: SceneId) => Math.round(SCENE_META[id].frames / FPS);
