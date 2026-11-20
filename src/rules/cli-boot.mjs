/**
 * What the lib modules that export a runCLI share at the process boundary:
 * the guard that runs the CLI only when node was started on the module's own
 * file, the step that hands a runCLI result to the process, and the strict
 * flags-only parser wire-proof.mjs and worktree-preamble.mjs read their
 * arguments with. Every runCLI returns `{exitCode, stdout, stderr}` and never
 * calls process.exit, so tests drive it in-process; exitWith is the one place
 * a result reaches the real process.
 */
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * True when node was started on the module whose `import.meta.url` is
 * `moduleUrl`. realpath on both sides, so a symlinked invocation (a symlinked
 * CLAUDE_PROJECT_DIR) or a path containing a space still resolves as main.
 * O3a ADV-13: the old `path.resolve(argv[1]) === path.resolve(new
 * URL(...).pathname)` compared a raw fs path against a URL-encoded one, so
 * EITHER shape made the CLI print nothing and exit 0, which its caller reads
 * as a pass: a write that never happened, a gate that never ran.
 */
export function isMainModule(moduleUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

const flushed = (stream, text) =>
  new Promise((resolve) => {
    if (!text) return resolve()
    stream.once("error", resolve)
    stream.write(text, resolve)
  })

/**
 * A write to a pipe is asynchronous on macOS, so exiting straight after it
 * cuts stdout off at the pipe's 64KB buffer while the exit code still reports
 * the verdict; each write's callback is waited for first. The result is
 * awaited, and a missing or non-integer exitCode exits 2, because
 * process.exit(undefined) exits 0: a runCLI turned async whose boot line lost
 * its `await` would otherwise pass silently, which is ADV-13 again.
 */
export async function exitWith(pending) {
  const result = await pending
  if (!Number.isInteger(result?.exitCode)) {
    await flushed(process.stderr, "cli-boot: the CLI returned no integer exitCode, so it reported no verdict\n")
    process.exit(2)
  }
  await Promise.all([flushed(process.stdout, result.stdout), flushed(process.stderr, result.stderr)])
  process.exit(result.exitCode)
}

/**
 * Parses a CLI that takes flags only. Each `valueFlags` flag (`{"--flag":
 * "key"}`) takes exactly one value that does not itself start with `--`, each
 * `booleanFlags` flag takes none, no flag may be given twice unless it is one
 * of the `repeatableFlags` value flags, and any other word is refused,
 * `--flag=value` included. A repeatable flag's values arrive as an array in
 * the order given, duplicates kept. Returns `{values, booleans}`, the boolean
 * flags given as a Set, or `{error}` for the first word refused. Which flags
 * are required, how often, and in which combinations, is the caller's rule.
 */
export function parseFlags(argv, valueFlags, booleanFlags = [], repeatableFlags = []) {
  const values = {}
  const booleans = new Set()
  for (let i = 0; i < argv.length; i++) {
    if (booleanFlags.includes(argv[i])) {
      if (booleans.has(argv[i])) return { error: `${argv[i]} given twice` }
      booleans.add(argv[i])
      continue
    }
    const key = Object.hasOwn(valueFlags, argv[i]) && valueFlags[argv[i]]
    if (!key) return { error: `unexpected argument ${JSON.stringify(argv[i])}` }
    const repeatable = repeatableFlags.includes(argv[i])
    if (!repeatable && Object.hasOwn(values, key)) return { error: `${argv[i]} given twice` }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith("--")) return { error: `${argv[i]} needs a value` }
    if (repeatable) (values[key] ??= []).push(value)
    else values[key] = value
    i++
  }
  return { values, booleans }
}
