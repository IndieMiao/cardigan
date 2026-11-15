/** Only host-selected categories and validated identifiers cross the control socket. */
const codes = [
  "operation_rejected",
  "artifact_unavailable",
  "approval_changed",
  "drain_unconfirmed",
  "candidate_unverified",
  "capacity_unavailable",
  "log_failed",
  "distribution_failed",
  "execution_exit_unconfirmed",
  "checks_failed",
  "cleanup_unconfirmed",
  "measurement_stopped",
] as const;
const stages = [
  "approval",
  "drain",
  "claim",
  "candidate",
  "capacity",
  "log",
  "distribution",
  "execution",
  "result",
  "cleanup",
] as const;
export type HandoffStage = (typeof stages)[number];
export interface HandoffDiagnostic {
  code: (typeof codes)[number];
  stage?: HandoffStage;
  attempt?: string;
  log_ref?: string;
  log_failed?: boolean;
  recovery?: "repair_artifact_then_restart_controller";
}
export class HandoffFailure extends Error {
  constructor(readonly diagnostic: HandoffDiagnostic) {
    super(
      `检查移交未确认（${diagnostic.code}${diagnostic.stage ? ` / ${diagnostic.stage}` : ""}）。围栏不会自动解除。${diagnostic.recovery ? "请修复制品后重新启动控制进程。" : ""}`,
    );
  }
}
export function handoffFailure(
  error: unknown,
  fallback: HandoffDiagnostic = { code: "operation_rejected" },
): HandoffFailure {
  return error instanceof HandoffFailure ? error : new HandoffFailure(fallback);
}
export function stageFailure(
  stage: HandoffStage,
  stopped = false,
): HandoffDiagnostic {
  if (stopped) return { code: "measurement_stopped", stage };
  const code: Record<HandoffStage, HandoffDiagnostic["code"]> = {
    approval: "approval_changed",
    drain: "drain_unconfirmed",
    claim: "operation_rejected",
    candidate: "candidate_unverified",
    capacity: "capacity_unavailable",
    log: "log_failed",
    distribution: "distribution_failed",
    execution: "execution_exit_unconfirmed",
    result: "execution_exit_unconfirmed",
    cleanup: "cleanup_unconfirmed",
  };
  return { code: code[stage], stage };
}
export function readHandoffDiagnostic(value: unknown): HandoffDiagnostic {
  if (!value || typeof value !== "object")
    return { code: "operation_rejected" };
  const raw = value as Record<string, unknown>;
  if (
    !codes.some((c) => c === raw.code) ||
    (raw.stage !== undefined && !stages.some((s) => s === raw.stage)) ||
    (raw.attempt !== undefined &&
      (typeof raw.attempt !== "string" ||
        !/^measurement-[a-f0-9-]{36}$/u.test(raw.attempt))) ||
    (raw.log_ref !== undefined &&
      (typeof raw.attempt !== "string" ||
        raw.log_ref !== `${raw.attempt}.log`)) ||
    (raw.log_failed !== undefined && typeof raw.log_failed !== "boolean") ||
    (raw.recovery !== undefined &&
      raw.recovery !== "repair_artifact_then_restart_controller")
  )
    return { code: "operation_rejected" };
  return {
    code: raw.code as HandoffDiagnostic["code"],
    ...(raw.stage !== undefined ? { stage: raw.stage as HandoffStage } : {}),
    ...(raw.attempt !== undefined ? { attempt: raw.attempt as string } : {}),
    ...(raw.log_ref !== undefined ? { log_ref: raw.log_ref as string } : {}),
    ...(raw.log_failed !== undefined
      ? { log_failed: raw.log_failed as boolean }
      : {}),
    ...(raw.recovery !== undefined
      ? { recovery: "repair_artifact_then_restart_controller" as const }
      : {}),
  };
}
