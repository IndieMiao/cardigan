export type CheckKind = "machine" | "worker";
export interface CheckResult {
  status: "passed" | "failed";
  failed_steps: readonly string[];
}
export interface MachineCheckJob {
  id: string;
  project_id: string;
  machine_id: string;
  kind: CheckKind;
  status: CheckResult["status"] | "running";
  step: string;
  started_at: string;
  checked_at: string;
  failed_steps: readonly string[];
}
