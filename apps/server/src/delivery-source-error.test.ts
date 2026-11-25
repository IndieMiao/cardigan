/**
 * C-628: a Git delivery source that cannot be read says why — busy, runtime
 * target (with its reason code) or something else (its class) — in the
 * returned error and in one log line, never as exception text.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, ProjectId } from "@cardigan/domain";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import {
  PreparationQueueTimeout,
  RuntimeTargetError,
  type RuntimeTargets,
} from "@cardigan/host";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  classifyDeliverySourceError,
  type DeliverySourceErrorEntry,
  ServerGit,
} from "./git.js";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cardigan-source-error-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const project = "p" as ProjectId;
const assignment = {
  id: "A-7",
  project_id: project,
  machine_id: "local",
} as unknown as Assignment;
const subject = { kind: "git_head" as const, value: "a".repeat(40) };

function verifierThrowing(error: unknown) {
  const entries: DeliverySourceErrorEntry[] = [];
  const git = new ServerGit({
    dataDir,
    store: {
      getProject: () =>
        ({ id: project, repo_path: join(dataDir, "source") }) as never,
      listProjects: () => [],
    },
    // C-642: resolving the workspace target is the first step, before the lock.
    targets: {
      forWorkspace: () => {
        throw error;
      },
    } as unknown as RuntimeTargets,
    onSourceError: (entry) => entries.push(entry),
  });
  return { verifier: git.verifierFor(project), entries };
}

test("a lock timeout reads as busy and retryable", async () => {
  const { verifier, entries } = verifierThrowing(
    new RepositoryLockTimeoutError(30_000),
  );
  const result = await verifier.verify(subject, assignment);
  expect(result).toEqual({
    ok: false,
    error: {
      code: "validation_failed",
      message: "Git delivery source is busy (仓库忙，稍后重试)",
      details: { source_error: "repository_busy", retryable: true },
    },
  });
  expect(entries).toEqual([
    {
      event: "delivery_source_error",
      project_id: project,
      assignment_id: "A-7",
      source_error: "repository_busy",
      retryable: true,
    },
  ]);
  expect(classifyDeliverySourceError(new PreparationQueueTimeout())).toEqual({
    source_error: "repository_busy",
    retryable: true,
  });
});

test("a runtime target refusal keeps its reason code, including MCP gateway errors", async () => {
  const { verifier, entries } = verifierThrowing(
    new RuntimeTargetError("mcp_gateway_error"),
  );
  const result = await verifier.verify(subject, assignment);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toBe(
    "Git delivery source is unavailable: runtime target mcp_gateway_error",
  );
  expect(result.error.details).toEqual({
    source_error: "runtime_target",
    reason: "mcp_gateway_error",
    retryable: true,
  });
  expect(entries[0]).toMatchObject({
    source_error: "runtime_target",
    reason: "mcp_gateway_error",
  });
  expect(
    classifyDeliverySourceError(new RuntimeTargetError("machine_not_ready")),
  ).toEqual({
    source_error: "runtime_target",
    reason: "machine_not_ready",
    retryable: false,
  });
  // A code outside the fixed lists is never echoed.
  expect(
    classifyDeliverySourceError(
      new RuntimeTargetError("ssh -i /home/someone/.ssh/key failed"),
    ),
  ).toEqual({
    source_error: "runtime_target",
    reason: "target_invalid",
    retryable: false,
  });
});

test("anything else keeps only its error class, never the message", async () => {
  class WorkspaceExploded extends Error {}
  const { verifier, entries } = verifierThrowing(
    new WorkspaceExploded("secret path /home/someone/token"),
  );
  const result = await verifier.verify(subject, assignment);
  expect(result).toEqual({
    ok: false,
    error: {
      code: "validation_failed",
      message: "Git delivery source is unavailable",
      details: {
        source_error: "other",
        error_class: "WorkspaceExploded",
        retryable: false,
      },
    },
  });
  expect(JSON.stringify(entries)).not.toContain("secret");
  expect(entries[0]).toMatchObject({
    event: "delivery_source_error",
    source_error: "other",
    error_class: "WorkspaceExploded",
  });
  expect(classifyDeliverySourceError("not an error")).toEqual({
    source_error: "other",
    error_class: "unknown",
    retryable: false,
  });
});
