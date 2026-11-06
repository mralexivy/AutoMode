import { Composition } from 'remotion';
import { SCENES } from './scenes';
import { FPS, H, W } from './theme';
import { SOCIAL_FRAMES, SOCIAL_H, SOCIAL_W, SocialCut } from './social/SocialCut';

// The compositions for Remotion Studio and for rendering: npm run video:studio, npm run video:render.
export const RemotionRoot: React.FC = () => (
  <>
    {Object.entries(SCENES).map(([id, s]) => (
      <Composition key={id} id={id} component={s.component} durationInFrames={s.frames} fps={FPS} width={W} height={H} />
    ))}
    <Composition id="social-cut" component={SocialCut} durationInFrames={SOCIAL_FRAMES} fps={FPS} width={SOCIAL_W} height={SOCIAL_H} />
  </>
);
