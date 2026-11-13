import type { DeploymentRecord } from "./commands/deployment.js";

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
  isFastForward(from: string, to: string): Promise<boolean>;
  passedMergeGate(from: string, to: string): Promise<boolean>;
  acquire(): Promise<(() => Promise<void>) | undefined>;
  build(sha: string): Promise<{ build?: DeploymentBuild; log_tail: string }>;
  migrationsChanged(from: string, to: string): Promise<boolean>;
  backup(): Promise<void>;
  beforeStop(record: DeploymentRecord): Promise<DeploymentRecord>;
  stop(): Promise<void>;
  start(build: DeploymentBuild): Promise<void>;
  ready(): Promise<boolean>;
  promote(build: DeploymentBuild): Promise<void>;
  refreshRoles(): Promise<void>;
  record(record: DeploymentRecord): Promise<void>;
  now(): number;
}
