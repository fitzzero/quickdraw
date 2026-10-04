import { boardBurst } from "./board-burst";
import { boardSteady } from "./board-steady";
import { fatRead } from "./fat-read";
import { reconnectStorm } from "./reconnect-storm";
import type { Scenario, ScenarioName } from "./types";

export { SCENARIO_NAMES, type ScenarioName } from "./types";
export type {
  LoadgenMetrics,
  Measurement,
  Scenario,
  ScenarioContext,
  ScenarioRun,
  ServerMetrics,
} from "./types";

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  "board-steady": boardSteady,
  "board-burst": boardBurst,
  "reconnect-storm": reconnectStorm,
  "fat-read": fatRead,
};
