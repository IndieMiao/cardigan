import type {
  DeploymentOperation,
  DeploymentReadyRetry,
  DeploymentRecord,
} from "./commands/deployment.js";

export interface DeploymentBuild {
  readonly sha: string;
  /** Opaque to the controller; resolved only by the trusted host adapter. */
  readonly release: string;
}

export interface DeploymentDriver {
  readonly enabled: boolean;
  /** Check the owned service even when deployment is disabled or main is unchanged. */
  checkServer(): Promise<void>;
  /**
   * C-390, optional for legacy adapters: a human maintenance window is open;
   * no automatic deployment starts until it ends.
   */
  maintenanceActive?(): Promise<boolean>;
  current(): Promise<DeploymentBuild>;
  main(): Promise<string>;
  /** Host-verified human pin; optional for legacy adapters. */
  target?(): Promise<{
    readonly sha: string;
    readonly control_event_id?: string;
  }>;
  isFastForward(from: string, to: string): Promise<boolean>;
  passedMergeGate(from: string, to: string): Promise<boolean>;
  waitForEvidence(record: DeploymentRecord): Promise<void>;
  waitForCapacity(record: DeploymentRecord): Promise<void>;
  releaseCapacityWait(): Promise<void>;
  acquire(): Promise<(() => Promise<void>) | undefined>;
  build(sha: string): Promise<{ build?: DeploymentBuild; log_tail: string }>;
  migrationsChanged(from: string, to: string): Promise<boolean>;
  backup(): Promise<string>;
  /**
   * `interrupted` (C-609) is the detail behind `record.interrupted_operations`;
   * it is written to each source card, never to the deployment project.
   */
  beforeStop(
    record: DeploymentRecord,
    interrupted?: readonly DeploymentOperation[],
  ): Promise<DeploymentRecord>;
  stop(): Promise<void>;
  start(build: DeploymentBuild): Promise<void>;
  ready(): Promise<boolean>;
  /** Only allowlisted codes and process outcomes, never raw server output. */
  serverDiagnostics(stage: "start" | "ready"): string;
  /**
   * C-650: fixed labels of recognised start/ready failure causes (for
   * example a locked database) of the latest start; never raw output.
   */
  serverFailureCause?(): string | undefined;
  /**
   * C-650, optional for legacy adapters: automatic retries of a target whose
   * start/ready failed and was rolled back. Absent disables durable retries.
   */
  readonly readyRetryMax?: number | undefined;
  /** C-650: minimum gap (ms) before the next automatic retry. */
  readonly readyRetryIntervalMs?: number | undefined;
  /**
   * C-650: the latest durable retry state of one target (main or one human
   * pin), so a supervisor restart neither forgets nor resets the count.
   */
  readyRetryState?(
    to: string,
    controlEventId?: string,
  ): Promise<DeploymentReadyRetry | undefined>;
  promote(build: DeploymentBuild): Promise<void>;
  refreshRoles(): Promise<void>;
  record(record: DeploymentRecord): Promise<void>;
  now(): number;
  /**
   * C-609, optional for legacy adapters: deployments start at least this far
   * apart (ms); merges in between are deployed together as the latest main.
   */
  readonly batchWindowMs?: number;
  /** C-609: upper bound (ms) of the wait for managed long operations. */
  readonly operationWaitMs?: number;
  /** C-609: managed long operations still running; never throws. */
  operations?(): Promise<readonly DeploymentOperation[]>;
  /**
   * C-609: atomically close the start of new managed long operations and
   * return those still running at that instant. Operations requested while
   * the fence stands wait and run on the next server. Never throws.
   */
  fenceOperations?(): Promise<readonly DeploymentOperation[]>;
  /** C-609: reopen the start of managed long operations; never throws. */
  releaseOperationFence?(): Promise<void>;
  /**
   * Deduplicated audit of a batching or operation wait; never blocks. The
   * record carries per-kind counts only; `operations` (detail) is written to
   * each source card's own timeline.
   */
  waitForOperations?(
    record: DeploymentRecord,
    operations?: readonly DeploymentOperation[],
  ): Promise<void>;
  /** Interval between operation checks after the build (test seam). */
  sleep?(ms: number): Promise<void>;
}
