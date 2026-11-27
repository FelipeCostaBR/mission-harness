import { readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { extractPerAssertionRecords, isRecordableVerdict } from "../state/mission-state.mjs"

const ARTIFACT_PATH = /^(reviews|verdicts(?:\/incoming)?)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.json$/
const MAX_VISIBLE = 5

function sample(values) {
  return {
    count: values.length,
    first: values.slice(0, MAX_VISIBLE).map((value) => String(value).slice(0, 120)),
  }
}

/** Summarize an assigned artifact without printing or changing its raw evidence. */
export function evidenceDigest(missionPath, artifactPath) {
  const match = ARTIFACT_PATH.exec(artifactPath)
  if (!match) throw new Error("Use an assigned review or verdict JSON path inside the mission")

  const root = realpathSync(missionPath)
  const directory = join(root, match[1])
  const path = join(root, artifactPath)
  const artifact = realpathSync(path)
  if (dirname(artifact) !== directory || artifact !== path) {
    throw new Error("Evidence must be stored at the assigned mission path")
  }
  let doc
  try { doc = JSON.parse(readFileSync(artifact, "utf8")) } catch {
    throw new Error("Evidence is unreadable or is not valid JSON")
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("Evidence must be a JSON object")

  if (match[1] === "reviews") {
    if (!Array.isArray(doc.findings)) throw new Error("A review must contain a findings array")
    return {
      artifact: artifactPath,
      findings: sample(doc.findings.map((item) => item?.target ?? item?.problem ?? "Read finding in artifact")),
      rejected: Array.isArray(doc.killed) ? doc.killed.length : null,
    }
  }

  if (!isRecordableVerdict(doc)) throw new Error("No verdict records or boundary fields in artifact")
  const verdicts = Object.entries(extractPerAssertionRecords(doc))
  const count = (key) => Array.isArray(doc[key]) ? doc[key].length : 0

  return {
    artifact: artifactPath,
    assertions: verdicts.length,
    passing: verdicts.filter(([, status]) => status === "pass" || status === "passing").length,
    needsAttention: sample(verdicts.filter(([, status]) => status !== "pass" && status !== "passing").map(([id]) => id)),
    topLevelFailure: doc.verdict === "fail",
    boundaryViolations: count("boundaryViolations"),
    missingDefaults: count("missingDefaults"),
    testGaps: count("testGaps"),
    informational: count("informational"),
    designInconclusive: doc.designCompliance?.subjectiveMatch === "inconclusive",
  }
}
