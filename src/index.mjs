/**
 * Public API. Import the rules directly if you are building your own runner:
 *
 *   import { decideSelfHeal, partitionDisjoint } from "mission-harness"
 *
 * Every rule is pure and project-blind. Project knowledge arrives through
 * `mission.config.json`, loaded via `loadConfig()`.
 */

export { decideSelfHeal } from "./rules/self-heal.mjs"
export { resumePlan } from "./rules/resume.mjs"
export { partitionDisjoint, globsOverlap, globBase } from "./rules/partition.mjs"
export { boundaryViolations, pathWithinGlobs } from "./rules/boundary.mjs"
export { routeEscalation } from "./rules/escalation-route.mjs"
export {
  resolveSeat,
  rungOfSeat,
  correctiveSeatFromState,
  sameCheckFailedBefore,
  DEFAULT_SEAT_TABLE,
  CORRECTIVE_CAUSES,
} from "./rules/seat-ladder.mjs"
export { planSize, planSizeTier, SMALL_BELOW, LARGE_FROM } from "./rules/plan-size.mjs"
export { commitBoundaryReport, collectCommits } from "./rules/commit-boundary.mjs"
export { verifiedByRecordProblem, verifiedByProblems } from "./rules/verified-by.mjs"
export { validateScoutReply, SCOUT_REPLY_SCHEMA } from "./rules/scout-schema.mjs"
export { runCLI as runStateCommand, COMMAND_NAMES as STATE_COMMANDS } from "./state/mission-state.mjs"
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
  NO_DEVICE_STATES,
  FEATURE_SURFACES,
  decisionRecords,
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
  seatTable,
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
