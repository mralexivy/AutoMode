'use client';
import { Player, type PlayerRef } from '@remotion/player';
import { useEffect, useRef, useState } from 'react';
import { SCENES, type SceneId } from '@/remotion/scenes';
import { FPS, H, W } from '@/remotion/timing';
import { basePath } from '@/lib/shared';

// An AutoMode scene, drawn live by the Remotion Player. It starts on its own and loops, and it pauses while off
// screen, so a long page does not animate what nobody sees. Before the script loads, the rendered poster shows.
export function Motion({ id, className }: { id: SceneId; className?: string }) {
  const scene = SCENES[id];
  const box = useRef<HTMLDivElement>(null);
  const player = useRef<PlayerRef>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready || !box.current) return;
    const seen = new IntersectionObserver(([e]) => (e.isIntersecting ? player.current?.play() : player.current?.pause()), { threshold: 0.35 });
    seen.observe(box.current);
    return () => seen.disconnect();
  }, [ready]);

  return (
    <div
      ref={box}
      role="img"
      aria-label={`${scene.title}. ${scene.description}`}
      className={`not-prose my-6 overflow-hidden text-left rounded-2xl border shadow-[0_30px_80px_-30px_rgba(70,50,200,0.6)] ${className ?? ''}`}
      style={{ aspectRatio: `${W} / ${H}` }}
    >
      {ready ? (
        <Player
          ref={player}
          component={scene.component}
          durationInFrames={scene.frames}
          compositionWidth={W}
          compositionHeight={H}
          fps={FPS}
          autoPlay
          loop
          initiallyMuted
          style={{ width: '100%', height: '100%' }}
          acknowledgeRemotionLicense
        />
      ) : (
        <img src={`${basePath}/video/${id}.jpg`} alt="" width={W} height={H} className="h-full w-full" />
      )}
    </div>
  );
}
