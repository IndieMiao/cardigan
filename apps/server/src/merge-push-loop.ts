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
} from "@cardigan/domain";
import type { PushResult } from "@cardigan/git-transport";
import type { MergeGateConfiguration } from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import type { MergeGit } from "./git.js";
import { startTimerLoop } from "./loop.js";

export function mergeProjectSettings(
  configuration: MergeGateConfiguration,
  project: string,
): CommandState["project_settings"] {
  const config = configuration.forProject(project);
  return config.status === "enabled"
    ? {
        merge_gate_enabled: true,
        ...(config.push
          ? {
              merge_push: {
                target: config.push.target,
                branch: config.push.branch,
              },
            }
          : {}),
      }
    : undefined;
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
    const next = this.serial.then(async () => {
      await Promise.all(
        (project
          ? [project]
          : this.options.store.listProjects().map((p) => p.id)
        ).map((id) => this.project(id)),
      );
    });
    this.serial = next.catch(() => {});
    return next;
  }
  private async project(id: ProjectId): Promise<void> {
    if (this.abort.signal.aborted) return;
    const config = this.options.configuration.forProject(id),
      project = this.options.git.projectOf(id);
    if (config.status !== "enabled" || !config.push || !project) return;
    const push = config.push;
    try {
      const attempt = this.command(id, (s, a, ports) =>
        beginMergePush(
          s,
          a,
          {
            target: push.target,
            branch: push.branch,
            attempt_id: randomUUID(),
          },
          ports,
        ),
      );
      if (!attempt || this.abort.signal.aborted) return;
      let outcome: PushResult;
      try {
        // C-94: publish only first-parent history the merge loop recorded.
        // A foreign commit holds the target instead of reaching the remote.
        const { base_sha } = attempt;
        if (!base_sha || !this.options.git.pushRange)
          throw new Error("Push range cannot be checked");
        const chain = await this.options.git.pushRange(
          project,
          { base: base_sha, sha: attempt.sha },
          MERGE_PUSH_RANGE_LIMIT + 1,
        );
        if (this.abort.signal.aborted) return;
        const checked = this.command(id, (s, a, ports) =>
          checkMergePushRange(
            s,
            a,
            {
              target: attempt.target,
              attempt_id: attempt.attempt_id,
              chain,
            },
            ports,
          ),
        );
        if (checked.status === "held") return;
        const included = this.options.store.uow.read((tx) => {
          const events = tx.events.listAfter(id, undefined, 0);
          return attempt.queue_ids.map((queueId) => {
            const event = events.find(
              (e) => e.id === queueId && e.type === "merge_push_queued",
            );
            if (!event) throw new Error("Missing queued merge");
            return (event.payload as { sha: string }).sha;
          });
        });
        outcome = this.options.git.push
          ? await this.options.git.push(
              project,
              { sha: attempt.sha, included },
              config.push,
              this.abort.signal,
            )
          : { status: "failed", reason: "other" };
      } catch {
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
  options: MergePushOptions & { readonly intervalMs?: number },
) {
  const executor = new MergePushExecutor(options);
  const loop = startTimerLoop({
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
