import type {
  DeploymentOperation,
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
  beforeStop(record: DeploymentRecord): Promise<DeploymentRecord>;
  stop(): Promise<void>;
  start(build: DeploymentBuild): Promise<void>;
  ready(): Promise<boolean>;
  /** Only allowlisted codes and process outcomes, never raw server output. */
  serverDiagnostics(stage: "start" | "ready"): string;
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
  /** Deduplicated audit of a batching or operation wait; never blocks. */
  waitForOperations?(record: DeploymentRecord): Promise<void>;
  /** Interval between operation checks after the build (test seam). */
  sleep?(ms: number): Promise<void>;
}
