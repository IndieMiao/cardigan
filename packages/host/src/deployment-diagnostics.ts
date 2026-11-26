import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DeploymentRecord, ProjectId } from "@cardigan/domain";
import { gitSafetyArguments } from "@cardigan/git-transport";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

const exec = promisify(execFile);
const validSha = (sha: unknown): sha is string =>
  typeof sha === "string" && /^[a-f0-9]{40}$/u.test(sha);

/** Read-only projection; no process, paths, config, environment or execution hooks. */
export async function readDeploymentDiagnostics(
  store: Store,
  project: ProjectId,
) {
  if (project !== "cardigan") return undefined;
  const events = store.uow.read((tx) => loadCommandState(tx, project).events);
  const records = events
    .filter(
      (e) => e.type === "host_deployment_recorded" && e.actor.kind === "system",
    )
    .slice(-20)
    .reverse()
    .map((e) => {
      const record = e.payload as unknown as DeploymentRecord;
      return {
        attempt: record.attempt,
        from: record.from,
        to: record.to,
        status: record.status,
        build: record.build,
        ready: record.ready,
        downtime_ms: record.downtime_ms,
        summary: record.summary,
        ...(record.failure_stage
          ? { failure_stage: record.failure_stage }
          : {}),
        ...(record.backup_file ? { backup_file: record.backup_file } : {}),
        ...(record.waiting_since
          ? { waiting_since: record.waiting_since }
          : {}),
        ...(record.capacity_wait_exceeded === undefined
          ? {}
          : { capacity_wait_exceeded: record.capacity_wait_exceeded }),
        ...(record.blocking_checks
          ? { blocking_checks: record.blocking_checks }
          : {}),
        ...(record.evidence_wait_exceeded === undefined
          ? {}
          : { evidence_wait_exceeded: record.evidence_wait_exceeded }),
        ...(record.log_tail === undefined ? {} : { log_tail: record.log_tail }),
        ...(record.ready_retry
          ? {
              ready_retry: {
                failures: record.ready_retry.failures,
                max: record.ready_retry.max,
                ...(record.ready_retry.next_at
                  ? { next_at: record.ready_retry.next_at }
                  : {}),
              },
            }
          : {}),
        ...(record.post_deploy_failed === undefined
          ? {}
          : { post_deploy_failed: record.post_deploy_failed }),
        ...(record.stop_snapshot
          ? {
              stop_snapshot: {
                captured_at: record.stop_snapshot.captured_at,
                runs: record.stop_snapshot.runs.map((r) => ({
                  run_id: r.run_id,
                  assignment_id: r.assignment_id,
                  card_id: r.card_id,
                })),
              },
            }
          : {}),
        at: e.created_at,
      };
    });
  // C-743: each retention round, newest first: what it removed and freed.
  const retention = events
    .filter(
      (e) =>
        (e.type === "host_retention_round" ||
          e.type === "host_run_dirs_reclaimed") &&
        e.actor.kind === "system",
    )
    .slice(-30)
    .reverse()
    .map((e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const n = (v: unknown) => (Number.isSafeInteger(v) ? Number(v) : 0);
      return {
        at: e.created_at,
        scope:
          e.type === "host_retention_round"
            ? ("deployment" as const)
            : ("runs" as const),
        ...(typeof p.machine_id === "string"
          ? { machine_id: p.machine_id }
          : {}),
        mode: p.mode === "preview" ? "preview" : "auto",
        removed: n(p.removed),
        freed_bytes: n(p.freed_bytes),
        ...(typeof p.notice === "string" ? { notice: p.notice } : {}),
      };
    });
  const result = {
    records,
    retention,
    deployed_sha: null as string | null,
    main_sha: null as string | null,
    commits_behind: null as number | null,
    fast_forward: null as boolean | null,
  };
  const file = store.database
    .prepare("PRAGMA database_list")
    .all()
    .find((r) => r.name === "main")?.file;
  if (typeof file !== "string" || !file) return result;
  const dataDir = dirname(file);
  try {
    const handle = await open(
      join(dataDir, "self-deploy/state.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.size > 65536
      )
        return result;
      const state = JSON.parse(await handle.readFile("utf8"));
      if (validSha(state.current?.sha)) result.deployed_sha = state.current.sha;
    } finally {
      await handle.close();
    }
  } catch {
    /* A host without the supervisor has no deployed identity yet. */
  }
  const git = (args: string[]) =>
    exec(
      "git",
      [
        ...gitSafetyArguments,
        "--git-dir",
        join(dataDir, "central/cardigan.git"),
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
        timeout: 5000,
        maxBuffer: 65536,
      },
    );
  try {
    const main = (
      await git(["rev-parse", "--verify", "refs/heads/main^{commit}"])
    ).stdout.trim();
    if (!validSha(main)) return result;
    result.main_sha = main;
    if (result.deployed_sha) {
      try {
        await git(["merge-base", "--is-ancestor", result.deployed_sha, main]);
        result.fast_forward = true;
      } catch (error) {
        if ((error as { code?: number }).code === 1)
          result.fast_forward = false;
      }
      if (result.fast_forward) {
        const count = Number(
          (
            await git([
              "rev-list",
              "--count",
              `${result.deployed_sha}..${main}`,
            ])
          ).stdout.trim(),
        );
        if (Number.isSafeInteger(count) && count >= 0)
          result.commits_behind = count;
      }
    }
  } catch {
    /* Never forward raw Git errors or private configuration paths. */
  }
  return result;
}
