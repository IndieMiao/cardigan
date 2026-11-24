import { Worker } from "node:worker_threads";
import type { DomainError } from "@cardigan/domain";
import {
  type Identity,
  type ProjectSnapshotInput,
  type ProjectSnapshotRead,
  type ToolContext,
  ToolError,
} from "@cardigan/mcp-server";

export interface McpReaderOptions {
  dbPath: string;
}

export interface McpReadRequest {
  readonly kind: "project_snapshot";
  readonly id: number;
  readonly actor: Identity["actor"];
  readonly input: ProjectSnapshotInput;
}

interface McpReadResponse {
  readonly id: number;
  readonly value?: ProjectSnapshotRead;
  readonly error?: DomainError;
  readonly worker_ms: number;
}

/**
 * C-648: heavy MCP reads run on one private read-only connection in a worker
 * thread. Requests queue in order there; a failed worker rejects its pending
 * reads and the next read starts a new one. Writes stay on the caller.
 */
export class McpReader {
  private worker: Worker | undefined;
  private closed = false;
  private serial = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: ProjectSnapshotRead): void;
      reject(error: unknown): void;
      timing?: ToolContext["recordTiming"];
      posted: number;
    }
  >();
  constructor(private readonly options: McpReaderOptions) {}

  private start() {
    if (this.closed)
      throw new ToolError("validation_failed", "MCP reader is closed");
    if (this.worker) return this.worker;
    const worker = new Worker(
      new URL("../dist/mcp-read-worker.js", import.meta.url),
      { workerData: { dbPath: this.options.dbPath } },
    );
    this.worker = worker;
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const p of this.pending.values())
        p.reject(new ToolError("validation_failed", "参考资料读取失败。"));
      this.pending.clear();
      void worker.terminate();
    };
    worker.on("error", failed);
    worker.on("exit", failed);
    worker.on("message", (message: McpReadResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.timing?.("read_worker", message.worker_ms);
      pending.timing?.("read_roundtrip", performance.now() - pending.posted);
      if (message.error)
        pending.reject(
          new ToolError(
            message.error.code,
            message.error.message,
            message.error.details as Record<string, unknown> | undefined,
          ),
        );
      else if (message.value) pending.resolve(message.value);
      else
        pending.reject(
          new ToolError("validation_failed", "参考资料读取失败。"),
        );
    });
    return worker;
  }

  /** The actor is server-derived; the bearer token never crosses the thread. */
  projectSnapshot(
    context: ToolContext,
    input: ProjectSnapshotInput,
  ): Promise<ProjectSnapshotRead> {
    const worker = this.start();
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        timing: context.recordTiming,
        posted: performance.now(),
      });
      const request: McpReadRequest = {
        kind: "project_snapshot",
        id,
        actor: context.identity.actor,
        input,
      };
      worker.postMessage(request);
    });
  }

  async close() {
    this.closed = true;
    for (const p of this.pending.values())
      p.reject(new ToolError("validation_failed", "MCP reader closed"));
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
