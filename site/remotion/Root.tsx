import { Composition } from 'remotion';
import { SCENES } from './scenes';
import { FPS, H, W } from './theme';

// The compositions for Remotion Studio and for rendering: npm run video:studio, npm run video:render.
export const RemotionRoot: React.FC = () => (
  <>
    {Object.entries(SCENES).map(([id, s]) => (
      <Composition key={id} id={id} component={s.component} durationInFrames={s.frames} fps={FPS} width={W} height={H} />
    ))}
  </>
);
