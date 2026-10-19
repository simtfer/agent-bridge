import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWindows } from "./util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const JOBRUN_PATH = path.join(ROOT, "bin", "jobrun.exe");

export function jobrunAvailable() {
  return isWindows() && fs.existsSync(JOBRUN_PATH);
}

/**
 * Wrap a harness command in jobrun.exe:
 *  - Job Object with kill-on-close (no orphaned grandchildren)
 *  - optional wall-clock timeout
 *  - per-process / per-job memory limit
 *  - active process limit
 *
 * jobrun copies stdin/stdout/stderr byte-for-byte, so JSONL protocols keep working.
 */
export function wrapSpawn(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutSec = 0,
    memoryMb = 4096,
    processLimit = 128,
  } = options;

  if (!options.enabled || !jobrunAvailable()) {
    return { command, args, usedJobObject: false };
  }

  return {
    command: JOBRUN_PATH,
    args: [
      "--cwd",
      cwd,
      "--timeout",
      String(timeoutSec || 0),
      "--memory-mb",
      String(memoryMb || 0),
      "--processes",
      String(processLimit || 0),
      "--",
      command,
      ...args,
    ],
    usedJobObject: true,
  };
}
