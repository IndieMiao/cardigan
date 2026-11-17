import { parentPort, workerData } from "node:worker_threads";
import type {
  ProjectId,
  Runtime,
  RuntimeInteractionReader,
} from "@cardigan/domain";
import { HostOpsService } from "@cardigan/host";
import { type Identity, ToolError, toDomainError } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import type { DiagnosticsOptions } from "./diagnostics-reader.js";

const port = parentPort;
if (!port)
  throw new Error("Diagnostics worker requires its private parent port");
const options = workerData as DiagnosticsOptions & {
  interactionAvailable?: boolean;
};
const store = Store.open({ dbPath: options.dbPath, migrate: false });
store.database.exec("PRAGMA query_only = ON");
const pending = new Map<number, (result: unknown) => void>();
const services = new Set<HostOpsService>();
const reads = new Set<Promise<void>>();
let serial = 0;
let closing = false;
// Only status IO uses the existing host runtime. No new runtime or request concurrency limit.
const status = (ref: Parameters<Runtime["status"]>[0]) =>
  new Promise<Awaited<ReturnType<Runtime["status"]>> | undefined>((resolve) => {
    if (closing) {
      resolve(undefined);
      return;
    }
    const id = ++serial;
    pending.set(id, (result) =>
      resolve(result as Awaited<ReturnType<Runtime["status"]>> | undefined),
    );
    port.postMessage({ kind: "status", id, ref });
  });

const interaction: RuntimeInteractionReader["interaction"] = (ref, identity) =>
  new Promise((resolve) => {
    if (closing) {
      resolve({
        ok: false,
        error: { code: "runtime_unavailable", message: "交互观察不可用" },
      });
      return;
    }
    const id = ++serial;
    pending.set(id, (result) =>
      resolve(
        result as Awaited<ReturnType<RuntimeInteractionReader["interaction"]>>,
      ),
    );
    port.postMessage({ kind: "interaction", id, ref, identity });
  });

async function read(message: {
  id: number;
  kind: string;
  identity: Identity;
  project?: string;
  now?: string;
}) {
  // Observations belong to this request's configuration, clock and session generations.
  const service = new HostOpsService({
    store,
    runtime: {
      status,
      ...(options.interactionAvailable ? { interaction } : {}),
    } as unknown as Runtime,
    clock: { now: () => message.now ?? new Date().toISOString() },
    ...(options.upstream ? { upstream: options.upstream } : {}),
    ...(options.contextUsage ? { contextUsage: options.contextUsage } : {}),
    snapshot: async () => {
      throw new Error("Read-only diagnostics");
    },
  });
  services.add(service);
  try {
    const timings: Record<string, number> = {};
    const value =
      message.kind === "execution"
        ? await service.executionDiagnostics(message.project as ProjectId)
        : await service.tools.read(
            {
              store,
              identity: message.identity,
              recordTiming: (stage, ms) => {
                timings[stage] = ms;
              },
            },
            message.project,
          );
    if (!closing) port?.postMessage({ id: message.id, value, timings });
  } catch (error) {
    if (!closing)
      port?.postMessage({
        id: message.id,
        error:
          error instanceof Error && !(error instanceof ToolError)
            ? {
                code: "validation_failed",
                message: "Diagnostics reader unavailable",
              }
            : toDomainError(error),
      });
  } finally {
    await service.close();
    services.delete(service);
  }
}

port.on("message", (message) => {
  if (message.kind === "status" || message.kind === "interaction") {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.kind === "close") {
    closing = true;
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
    void Promise.allSettled(
      [...services].map((service) => service.close()),
    ).then(async () => {
      await Promise.allSettled(reads);
      store.close();
      port.close();
    });
    return;
  }
  if (!["read", "execution"].includes(message.kind) || closing) return;
  const request = read(message).finally(() => reads.delete(request));
  reads.add(request);
});
