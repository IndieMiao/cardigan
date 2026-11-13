import type { DeploymentRecord } from "./commands/deployment.js";

export interface DeploymentBuild {
  readonly sha: string;
  /** Opaque to the controller; resolved only by the trusted host adapter. */
  readonly release: string;
}

export interface DeploymentDriver {
  readonly enabled: boolean;
  current(): Promise<DeploymentBuild>;
  main(): Promise<string>;
  isFastForward(from: string, to: string): Promise<boolean>;
  passedMergeGate(from: string, to: string): Promise<boolean>;
  acquire(): Promise<(() => Promise<void>) | undefined>;
  build(sha: string): Promise<{ build?: DeploymentBuild; log_tail: string }>;
  migrationsChanged(from: string, to: string): Promise<boolean>;
  backup(): Promise<void>;
  stop(): Promise<void>;
  start(build: DeploymentBuild): Promise<void>;
  ready(): Promise<boolean>;
  promote(build: DeploymentBuild): Promise<void>;
  refreshRoles(): Promise<void>;
  record(record: DeploymentRecord): Promise<void>;
  now(): number;
}
