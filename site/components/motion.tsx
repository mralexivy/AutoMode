'use client';
import { Player, type PlayerRef } from '@remotion/player';
import { useEffect, useRef, useState } from 'react';
import { SCENES, type SceneId } from '@/remotion/scenes';
import { FPS, H, W } from '@/remotion/timing';
import { basePath } from '@/lib/shared';

// An AutoMode scene, drawn live by the Remotion Player. It plays only while on screen and stays still for people
// who ask for reduced motion. Before the script loads, the rendered poster shows in its place.
export function Motion({ id, className }: { id: SceneId; className?: string }) {
  const scene = SCENES[id];
  const box = useRef<HTMLDivElement>(null);
  const player = useRef<PlayerRef>(null);
  const [ready, setReady] = useState(false);
  const [still, setStill] = useState(false);

  useEffect(() => {
    setReady(true);
    setStill(matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  useEffect(() => {
    if (!ready || still || !box.current) return;
    const seen = new IntersectionObserver(([e]) => (e.isIntersecting ? player.current?.play() : player.current?.pause()), { threshold: 0.35 });
    seen.observe(box.current);
    return () => seen.disconnect();
  }, [ready, still]);

  return (
    <div
      ref={box}
      role="img"
      aria-label={`${scene.title}. ${scene.description}`}
      className={`not-prose my-6 overflow-hidden rounded-2xl border shadow-[0_30px_80px_-30px_rgba(70,50,200,0.6)] ${className ?? ''}`}
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
          loop
          initialFrame={still ? scene.frames - 1 : 0}
          style={{ width: '100%', height: '100%' }}
          acknowledgeRemotionLicense
        />
      ) : (
        <img src={`${basePath}/video/${id}.jpg`} alt="" width={W} height={H} className="h-full w-full" />
      )}
    </div>
  );
}
