export const runtimeErrorCodes = [
  "runtime_not_found",
  "runtime_unavailable",
  "version_mismatch",
  "runtime_timeout",
  "runtime_queue_timeout",
  "runtime_conflict",
  "invalid_launch",
] as const;
export type RuntimeErrorCode = (typeof runtimeErrorCodes)[number];
export interface RuntimeError {
  readonly code: RuntimeErrorCode;
  readonly message: string;
}
export type RuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RuntimeError };

export const retirementReasons = {
  target_rejected: "回收目标未通过路由校验或连接失败",
  machine_unregistered: "项目未登记这台机器，请先核对机器登记",
  worker_unconfigured: "主机未配置这台机器的 worker，请先核对执行端配置",
  target_mismatch: "会话引用与当前执行目标不匹配，请先核对目标绑定",
  target_changed: "路由期间执行目标发生变化",
  unsupported: "运行时不支持空闲回收",
  hc_failed: "hc 请求未成功",
  identity_changed: "终端身份或启动代次不匹配",
  terminal_busy: "终端仍在工作或等待处理",
  conditional_close_unavailable: "终端管理器不支持绑定原代次关闭",
  kept_terminal: "终端在程序退出后会保留 shell",
  terminal_not_live: "hc 未报告终端存活或已结束",
  missing_pid: "hc 未返回有效的终端进程号",
  missing_creation_time: "hc 未返回有效的终端创建时刻",
  pidfd_unavailable: "执行端不支持 pidfd",
  permission_denied: "执行端拒绝读取或操作目标进程",
  marker_mismatch: "进程的 hc 终端标记不匹配",
  process_gone: "探测时原进程已消失，尚未确认终端退出",
  probe_invalid: "未取得有效的进程身份证明",
  guard_changed: "发信号前空闲资格已改变",
  still_live: "等待结束后终端仍存活",
  confirmation_pending: "尚未确认原会话退出",
  prompt_not_idle: "hc 未报告活动，绑定的提示符也不是空闲的空输入框",
  workspace_not_clean: "工作区有未提交改动，或无法证明工作区干净",
} as const;

/** C-626: which owner-bound stop a system-ended turn used. Bounded facts only. */
export type RetirementStop = {
  readonly path: "linux_pidfd" | "darwin_idle_owner" | "darwin_pid";
  readonly signal: "TERM";
  readonly pid?: number;
};

export type RetirementDispatchWait =
  | { source: "owner"; status: RuntimeErrorCode | "unknown" | "unsupported" }
  | { source: "snapshot"; status: RuntimeErrorCode | "unknown" | "exited" }
  | { source: "replacement"; status: "replacement_required" };

/** Only structured, bounded facts may cross the runtime/host boundary. */
export type RetirementEvidence = {
  readonly reason: keyof typeof retirementReasons;
  readonly stage: "target" | "get" | "probe" | "HUP" | "TERM" | "confirm";
  readonly terminal_state?: "live" | "finished" | "other";
  readonly runtime_code?: RuntimeErrorCode;
  readonly hc_kind?: string;
  readonly exit_code?: number;
  readonly observation?: "alive" | "exited" | "unknown" | RuntimeErrorCode;
  readonly stop?: RetirementStop;
  /** C-746: the macOS idle owner's bounded refusal code (`workspace_cwd`,
   * `worktree_dirty`, `terminal_not_idle`, `terminal_unreadable`, `no_reply`,
   * ...). Names the failed proof; never a path, file name or screen text. */
  readonly owner_reason?: string;
  /** C-746: set when `owner_reason` was re-derived read-only from the worker
   * because the owner (enrolled before C-746) closed without naming it. */
  readonly owner_reason_source?: "worker_probe";
  /** C-804: under `conditional_close_unavailable`, the macOS idle-owner
   * precondition that failed (`enrolled_process_missing`, `seed_missing`,
   * `owner_not_listening`, `owner_key_mismatch`, ...). A bounded token for
   * diagnosis only; the reason and every decision on it are unchanged. */
  readonly precondition?: string;
  /** C-804: the host's record of this launch's idle-owner enrollment:
   * `enrolled`, the skip reason (`seed_unavailable`, `launch_shape`, ...),
   * `unrecorded` or `unreadable`. Never a path, key, seed or signature. */
  readonly enrollment?: string;
};
export type RetirementSignalEvidence = {
  readonly pid: number;
  readonly signals: readonly ("HUP" | "TERM")[];
  readonly exit_code?: number;
  readonly exit_reason?: string;
};
export type IdleRetirementResult =
  | {
      readonly outcome: "exited";
      /** System-turn stops only: the probed process and its group are gone,
       * checked by the kernel after the terminal finished. */
      readonly process_group_exited?: true;
      readonly stop?: RetirementStop;
      /** Only with `report_signals`: the probed program PID and the signals
       * this call actually sent before the terminal finished. */
      readonly signalled?: RetirementSignalEvidence;
    }
  | {
      readonly outcome: "withdrawn" | "timeout" | "uncertain";
      readonly evidence: RetirementEvidence;
    };

/** These are properties of this terminal/platform. Do not keep retrying signals. */
export const retirementObserveOnly = (evidence?: RetirementEvidence) =>
  evidence !== undefined &&
  [
    "kept_terminal",
    "pidfd_unavailable",
    "unsupported",
    "conditional_close_unavailable",
  ].includes(evidence.reason);

export type RetirementSettlement =
  | IdleRetirementResult
  | { readonly outcome: "observing"; readonly evidence: RetirementEvidence };
