import { BenchmarkRace, BENCHMARK_FRAMES } from './BenchmarkRace';
import { CacheCheck, CACHE_FRAMES } from './CacheCheck';
import { SCENE_META, type SceneId } from './meta';
import { ROUTE_DEMO_FRAMES, RouteDemo } from './RouteDemo';
import { WorkflowFlow, WORKFLOW_FRAMES } from './WorkflowFlow';

// Every AutoMode scene, by id: its component and length, with the facts from meta.ts.
export const SCENES = {
  'route-demo': { ...SCENE_META['route-demo'], component: RouteDemo, frames: ROUTE_DEMO_FRAMES },
  'benchmark-race': { ...SCENE_META['benchmark-race'], component: BenchmarkRace, frames: BENCHMARK_FRAMES },
  'workflow-flow': { ...SCENE_META['workflow-flow'], component: WorkflowFlow, frames: WORKFLOW_FRAMES },
  'cache-check': { ...SCENE_META['cache-check'], component: CacheCheck, frames: CACHE_FRAMES },
};

export type { SceneId };
