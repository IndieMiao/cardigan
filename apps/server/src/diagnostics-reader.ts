import { Worker } from "node:worker_threads";
import type {
  Clock,
  ProjectId,
  Runtime,
  RuntimeInteractionReader,
} from "@cardigan/domain";
import type { HostOpsService } from "@cardigan/host";
import {
  type Identity,
  type ToolContext,
  ToolError,
} from "@cardigan/mcp-server";
import type { LaunchConfig } from "@cardigan/roles";

export interface DiagnosticsOptions {
  dbPath: string;
  upstream?: LaunchConfig;
  contextUsage?: Omit<
    NonNullable<
      ConstructorParameters<typeof HostOpsService>[0]["contextUsage"]
    >,
    "signal"
  >;
}

/** One private reader connection; no command state is decoded on the Web thread. */
export class DiagnosticsReader {
  private worker: Worker | undefined;
  private closed = false;
  private serial = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: unknown): void;
      timing?: ToolContext["recordTiming"];
    }
  >();
  constructor(
    private readonly options: DiagnosticsOptions,
    private readonly runtime: Runtime &
      Partial<RuntimeInteractionReader> & { diagnostics?: () => unknown },
    private readonly clock?: Clock,
  ) {}

  private start() {
    if (this.closed)
      throw new ToolError("illegal_transition", "Diagnostics reader is closed");
    if (this.worker) return this.worker;
    const worker = new Worker(
      new URL("../dist/diagnostics-worker.js", import.meta.url),
      {
        workerData: {
          ...this.options,
          interactionAvailable: typeof this.runtime.interaction === "function",
        },
      },
    );
    this.worker = worker;
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const p of this.pending.values())
        p.reject(
          new ToolError("validation_failed", "Diagnostics reader unavailable"),
        );
      this.pending.clear();
      void worker.terminate();
    };
    worker.on("error", failed);
    worker.on("exit", failed);
    worker.on("message", (message) => {
      if (message.kind === "status" || message.kind === "interaction") {
        if (this.closed || this.worker !== worker) return;
        void Promise.resolve()
          .then<unknown>(() =>
            message.kind === "interaction"
              ? this.runtime.interaction?.(message.ref, message.identity)
              : this.runtime.status(message.ref),
          )
          .then(
            (result) =>
              worker.postMessage({
                kind: message.kind,
                id: message.id,
                result,
              }),
            () =>
              worker.postMessage({
                kind: message.kind,
                id: message.id,
                result: undefined,
              }),
          );
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      for (const [stage, ms] of Object.entries(message.timings ?? {}))
        pending.timing?.(stage, ms as number);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.value);
    });
    return worker;
  }

  async read(context: ToolContext, project?: string) {
    context.revalidateToken?.();
    // The identity is server-derived. Never forward the bearer token or request headers.
    const identity: Identity = context.identity;
    const worker = this.start();
    const id = ++this.serial;
    const value = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timing: context.recordTiming });
      worker.postMessage({
        kind: "read",
        id,
        identity,
        project,
        now: this.clock?.now(),
      });
    });
    context.revalidateToken?.();
    // Match the original completion-time counters, after every status observation.
    return this.runtime.diagnostics && value && typeof value === "object"
      ? { ...value, runtime_calls: this.runtime.diagnostics() }
      : value;
  }

  async execution(
    project: ProjectId,
  ): Promise<Awaited<ReturnType<HostOpsService["executionDiagnostics"]>>> {
    const worker = this.start();
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) =>
          resolve(
            value as Awaited<
              ReturnType<HostOpsService["executionDiagnostics"]>
            >,
          ),
        reject,
      });
      worker.postMessage({
        kind: "execution",
        id,
        project,
        now: this.clock?.now(),
      });
    });
  }
  async close() {
    this.closed = true;
    for (const p of this.pending.values())
      p.reject(new ToolError("validation_failed", "Diagnostics reader closed"));
    this.pending.clear();
    const worker = this.worker;
    this.worker = undefined;
    if (worker)
      await new Promise<void>((resolve) => {
        worker.once("exit", () => resolve());
        worker.postMessage({ kind: "close" });
      });
  }
}
