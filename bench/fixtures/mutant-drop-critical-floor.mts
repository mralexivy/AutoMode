// A deliberately broken policy for Experiment A (regression sensitivity). It routes critical work, such as a schema
// migration that the risk rules mark critical, as if it carried no risk. bench/route-replay.mts --mode counterfactual
// must show it moving routes.
import { outcomeOf, routeAuto, type AutoRouteInput, type RouteOutcome } from '../../hooks/lib/auto-route.ts'

export function policy(input: AutoRouteInput): RouteOutcome {
  const risk = input.floor.risk === 'critical' ? 'none' : input.floor.risk
  return outcomeOf(routeAuto({ ...input, floor: { ...input.floor, risk, riskReasons: [] } }))
}
