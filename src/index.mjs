/**
 * Public API. Import the rules directly if you are building your own runner:
 *
 *   import { decideSelfHeal, partitionDisjoint } from "contractor-harness"
 *
 * Every rule is pure and project-blind. Project knowledge arrives through
 * `contractor.config.json`, loaded via `loadConfig()`.
 */

export { decideSelfHeal } from "./rules/self-heal.mjs"
export { resumePlan } from "./rules/resume.mjs"
export { partitionDisjoint, globsOverlap, globBase } from "./rules/partition.mjs"
export { boundaryViolations, pathWithinGlobs } from "./rules/boundary.mjs"
export { routeEscalation } from "./rules/escalation-route.mjs"
export { resolveWorkerSeat, SEAT_LADDER } from "./rules/worker-seat.mjs"
export { digestFromHandoff, HANDOFF_DIGEST_SCHEMA } from "./rules/handoff-digest.mjs"
export { rehydrationPlan, renderRehydrationBrief } from "./rules/rehydration.mjs"
export {
  checkBookkeeping,
  checkHandoffMeta,
  isBookkeepingClean,
  computeAdvanceReadiness,
  MISSION_STATUSES,
  NON_ACTIVE_STATUSES,
  ROUND_TYPES,
  UNVERIFIABLE_STATES,
  HYPOTHESIS_FAILED_STATE,
  ESCALATION_WORKER_MARKER,
} from "./rules/bookkeeping.mjs"

export {
  loadConfig,
  findProjectRoot,
  pathGlobsByArea,
  areaBySlug,
  resolveModel,
  escalationConfig,
  DEFAULT_CONFIG,
  CONFIG_FILENAME,
} from "./config.mjs"

export { arm, disarm, check, flagPath } from "./io/flag.mjs"
export {
  missionPaths,
  ensureMissionDirs,
  readState,
  writeState,
  readArtifacts,
  buildBrief,
  newMissionState,
  newContract,
} from "./io/mission.mjs"
export { routeFileToArea, unownedPaths, enqueueEdits, drainQueue, readQueue } from "./io/queue.mjs"
