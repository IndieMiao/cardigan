import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { ProjectId } from "@cardigan/domain";
import { type ExecutionConfig, executionPaths } from "@cardigan/runtime-herdr";

/**
 * Naming and path rules shared by every host-side entry point (M2 plan §3).
 *
 * Both `cardigan assignment start` and the Dispatcher start terminals for the
 * same Assignment, so the agent name and the run directory must be derived in
 * exactly one place: a second derivation would let the two entries collide or
 * disagree about where the launch files live.
 */

/** Project ids become directory names, so they must be safe segments. */
export function projectSegment(project_id: ProjectId): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(project_id)) {
    throw new Error(
      `项目编号不能用作目录名：${project_id}（只允许字母、数字和 . _ -）`,
    );
  }
  return project_id;
}

/** First 8 hex characters of sha256(project_id); M2 plan §3. */
export function projectShortCode(project_id: ProjectId): string {
  return createHash("sha256")
    .update(project_id, "utf8")
    .digest("hex")
    .slice(0, 8);
}

/**
 * `<role>-<project short code>-<card>-<work item>-<assignment>`, lowercased and
 * at most 32 characters; the role is truncated first so the codes survive.
 */
export function agentNameFor(input: {
  readonly role_id: string;
  readonly project_id: ProjectId;
  readonly card_id?: string;
  readonly work_item_id?: string;
  readonly assignment_id: string;
}): string {
  const parts = [
    input.role_id.toLowerCase(),
    projectShortCode(input.project_id),
    ...(input.card_id === undefined ? [] : [input.card_id.toLowerCase()]),
    ...(input.work_item_id === undefined
      ? []
      : [input.work_item_id.toLowerCase()]),
    input.assignment_id.toLowerCase(),
  ].map((part) => part.replace(/[^a-z0-9_-]/gu, "-"));
  const name = parts.join("-");
  if (name.length <= 32) return name;
  // Drop the role first, then shorten the role prefix if still too long.
  const tail = parts.slice(1).join("-");
  if (tail.length <= 32) {
    const room = 32 - tail.length - 1;
    return `${parts[0]?.slice(0, Math.max(1, room))}-${tail}`.slice(0, 32);
  }
  return tail.slice(-32);
}

export interface RunDirectory {
  readonly root: string;
  readonly runDir: string;
  readonly workDir: string;
}

/** `<data>/runs/<project>/<assignment>/`; worktree paths follow the same idea. */
export function runDirectory(input: {
  readonly dataDir: string;
  readonly project_id: ProjectId;
  readonly assignment_id: string;
  readonly worktreePath?: string;
  readonly execution?: ExecutionConfig;
}): RunDirectory {
  const { runDir } = executionPaths(
    input.execution ?? { mode: "local", dataDir: resolve(input.dataDir) },
    projectSegment(input.project_id),
    input.assignment_id,
  );
  const root = dirname(dirname(runDir));
  return { root, runDir, workDir: input.worktreePath ?? runDir };
}
