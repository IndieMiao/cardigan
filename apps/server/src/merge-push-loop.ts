import { randomUUID } from "node:crypto";
import {
  type Actor,
  beginMergePush,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  checkMergePushRange,
  MERGE_PUSH_RANGE_LIMIT,
  type ProjectId,
  type Result,
  recordMergePushResult,
  streamEventsBy,
} from "@cardigan/domain";
import { type CentralProject, centralBranch } from "@cardigan/git-service";
import type { PushResult } from "@cardigan/git-transport";
import { withMergeTransferBudget } from "@cardigan/git-transport";
import type { MergeGateConfiguration, MergePushConfig } from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import type { MergeGit } from "./git.js";
import { type LoopStartup, startTimerLoop } from "./loop.js";
import { MergeLockBusy, withPublication } from "./publication-lock.js";

export function mergeProjectSettings(
  configuration: MergeGateConfiguration,
  project: string,
): NonNullable<CommandState["project_settings"]> {
  const config = configuration.forProject(project);
  return config.status === "enabled"
    ? {
        merge_gate_enabled: true,
        ...(config.queue
          ? {
              merge_queue: {
                max_batch_size: config.queue.maxBatchSize,
                conflict_threshold: config.queue.conflictThreshold,
                window_timeout_ms: config.queue.windowTimeoutMs,
              },
            }
          : {}),
        ...(config.push?.length
          ? {
              merge_push: config.push.map((route) => ({
                target: route.target,
                branch: route.branch,
                base_branch: route.baseBranch,
                ...(route.registered ? { registered: true } : {}),
              })),
            }
          : {}),
      }
    : { merge_gate_enabled: config.status !== "disabled" };
}
export interface MergePushOptions {
  readonly store: Store;
  readonly git: Pick<MergeGit, "projectOf" | "push" | "pushRange">;
  readonly configuration: MergeGateConfiguration;
  readonly clock?: Clock;
  readonly onError?: (error: unknown) => void;
}
export class MergePushExecutor {
  private readonly abort = new AbortController();
  private serial: Promise<void> = Promise.resolve();
  constructor(private readonly options: MergePushOptions) {}
  stop(): void {
    this.abort.abort();
  }
  private command<T>(
    project: ProjectId,
    run: (
      state: CommandState,
      actor: Actor,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
  ): T {
    return this.options.store.uow.run((tx) => {
      const state = loadCommandState(
        tx,
        project,
        mergeProjectSettings(this.options.configuration, project),
      );
      const result = run(
        state,
        { kind: "system", project_id: project },
        {
          ids: tx.ids,
          clock: this.options.clock ?? { now: () => new Date().toISOString() },
        },
      );
      if (!result.ok) throw new Error("推送队列状态更新失败");
      persistEffect(tx, project, result.value);
      return result.value.data;
    });
  }
  tick(project?: ProjectId): Promise<void> {
    const next = withMergeTransferBudget(() =>
      this.serial.then(async () => {
        await Promise.all(
          (project
            ? [project]
            : this.options.store.listProjects().map((p) => p.id)
          ).map((id) => this.project(id)),
        );
      }),
    );
    this.serial = next.catch(() => {});
    return next;
  }
  private async project(id: ProjectId): Promise<void> {
    if (this.abort.signal.aborted) return;
    const config = this.options.configuration.forProject(id),
      registered = this.options.git.projectOf(id);
    if (config.status !== "enabled" || !config.push || !registered) return;
    // Each route publishes one central branch; routes have independent queues.
    for (const push of config.push) {
      if (this.abort.signal.aborted) return;
      let project: CentralProject;
      try {
        project = centralBranch(registered, push.baseBranch);
      } catch {
        this.options.onError?.(new Error("推送路由的中心分支名无效"));
        continue;
      }
      await this.route(id, project, push);
    }
  }
  private async route(
    id: ProjectId,
    project: CentralProject,
    push: MergePushConfig,
  ): Promise<void> {
    try {
      const attempt = this.command(id, (s, a, ports) =>
        beginMergePush(
          s,
          a,
          {
            target: push.target,
            branch: push.branch,
            base_branch: push.baseBranch,
            attempt_id: randomUUID(),
          },
          ports,
        ),
      );
      if (!attempt || this.abort.signal.aborted) return;
      let outcome: PushResult;
      try {
        // C-94: read current central main under the publication lock and
        // publish only if its whole first-parent history since a trusted
        // boundary was recorded by the merge loop (or accepted by the human).
        const { base_sha } = attempt;
        const range = this.options.git.pushRange;
        if (!base_sha || !range)
          throw new Error("Push range cannot be checked");
        const checked = await withPublication(id, async () => {
          const read = await range.call(
            this.options.git,
            project,
            base_sha,
            MERGE_PUSH_RANGE_LIMIT,
          );
          if (this.abort.signal.aborted) return undefined;
          return this.command(id, (s, a, ports) =>
            checkMergePushRange(
              s,
              a,
              {
                target: attempt.target,
                attempt_id: attempt.attempt_id,
                head: read.head,
                chain: read.chain,
                truncated: read.truncated,
              },
              ports,
            ),
          );
        });
        if (!checked) return;
        if (checked.status === "held") return;
        const included = this.options.store.uow.read((tx) => {
          const events = streamEventsBy(tx.events, id, undefined, "type", [
            "merge_push_queued",
          ]);
          return attempt.queue_ids.map((queueId) => {
            const event = events.find((e) => e.id === queueId);
            if (!event) throw new Error("Missing queued merge");
            return (event.payload as { sha: string }).sha;
          });
        });
        outcome = this.options.git.push
          ? await this.options.git.push(
              project,
              { sha: attempt.sha, included },
              push,
              this.abort.signal,
            )
          : { status: "failed", reason: "other" };
      } catch (error) {
        // No external push was attempted. Keep this attempt for the next tick.
        if (error instanceof MergeLockBusy) return;
        outcome = { status: "failed", reason: "other" };
      }
      // Stopping may leave an unknown external outcome. Keep the exact attempt
      // for restart; re-pushing its SHA is safe and must not advance the queue.
      if (this.abort.signal.aborted) return;
      this.command(id, (s, a, ports) =>
        recordMergePushResult(
          s,
          a,
          {
            target: attempt.target,
            attempt_id: attempt.attempt_id,
            ...outcome,
          },
          ports,
        ),
      );
    } catch {
      this.options.onError?.(
        new Error("合并推送队列读取或结果记录失败，请检查主机状态"),
      );
    }
  }
}
export function startMergePushLoop(
  options: MergePushOptions & {
    readonly startup?: LoopStartup | undefined;
    readonly intervalMs?: number;
  },
) {
  const executor = new MergePushExecutor(options);
  const loop = startTimerLoop({
    startup: options.startup,
    name: "merge-push",
    initialDelayMs: options.startup
      ? Math.min(600, options.intervalMs ?? 5000)
      : 0,
    tick: () => executor.tick(),
    intervalMs: options.intervalMs ?? 5_000,
    onError: options.onError ?? (() => {}),
  });
  return {
    executor,
    loop: {
      done: loop.done,
      stop: () => {
        executor.stop();
        return loop.stop();
      },
    },
  };
}
