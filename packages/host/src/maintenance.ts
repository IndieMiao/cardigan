import { randomUUID } from "node:crypto";
import { isHcVersionCompatible } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import {
  claimMaintenance,
  createMaintenance,
  MAINTENANCE_TERMINAL,
  type MaintenanceBusyItem,
  type MaintenanceOperation,
  type MaintenancePhase,
  type MaintenanceRecord,
  type MaintenanceRow,
  readMaintenance,
  releaseMaintenanceHolder,
  updateMaintenance,
  withHistory,
} from "./deployment-maintenance.js";
import {
  describeBusy,
  type MaintenanceActivity,
} from "./maintenance-activity.js";
import type {
  MaintenanceConfig,
  MaintenanceHcTarget,
} from "./maintenance-config.js";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SoftwareState {
  readonly sha: string | null;
  /** Identity of the server process; changes on every start. */
  readonly process: string | null;
  readonly ready: boolean;
}

/** Every side effect of a maintenance window; tests substitute a fake. */
export interface MaintenanceDriver {
  now(): string;
  sleep(ms: number): Promise<void>;
  run(
    argv: readonly string[],
    options?: { readonly input?: Uint8Array; readonly inherit?: boolean },
  ): Promise<CommandResult>;
  activity(): MaintenanceActivity;
  software(): Promise<SoftwareState>;
  portOpen(port: number): Promise<boolean>;
  deployPin(): string | null;
  /** Append the audit event; with `notice`, also tell the human (Needs You). */
  audit(
    record: MaintenanceRecord,
    phase: MaintenancePhase,
    note: string,
    notice?: string,
  ): void;
  say(line: string): void;
}

/** What one kind of maintenance work does while services are stopped. */
export interface MaintenanceWork {
  /** Declared before execution and kept in the record. */
  readonly rollback_scope: string;
  /** hc versions that must run after success; absent means "compatible". */
  readonly expected_hc?: Readonly<Record<string, string>>;
  apply(context: WorkContext): Promise<void>;
  /** Put back what `apply` changed; must be safe to repeat. */
  rollback(context: WorkContext): Promise<void>;
}

export interface WorkContext {
  readonly record: () => MaintenanceRecord;
  /** Persist a recovery point before the change it describes. */
  readonly save: (
    change: (record: MaintenanceRecord) => MaintenanceRecord,
  ) => void;
  readonly driver: MaintenanceDriver;
}

export type MaintenanceOutcome =
  | "completed"
  | "stopped"
  | "drain_timeout"
  | "abandoned"
  | "rolled_back"
  | "recovery_required";

const MANUAL_SCOPE =
  "人工操作：本命令只恢复它管理的服务启停和派活/自动部署暂停；人工改动的回退由操作人负责";

export function commandWork(argv: readonly string[]): MaintenanceWork {
  return {
    rollback_scope:
      "指定命令：失败时本命令重新启动它停止的服务并核对，恢复派活/自动部署；命令自身的改动不自动回退，需执行前自备备份",
    async apply({ driver }) {
      const result = await driver.run(argv, { inherit: true });
      if (result.code !== 0) throw new Error(`维护命令退出码 ${result.code}`);
    },
    async rollback() {},
  };
}

const manualWork: MaintenanceWork = {
  rollback_scope: MANUAL_SCOPE,
  async apply() {},
  async rollback() {},
};

export interface MaintenanceStart {
  readonly reason: string;
  readonly operation: MaintenanceOperation;
  readonly stop_hc: readonly string[];
  readonly timeout_ms?: number;
}

/**
 * C-390: drives one host maintenance window through its phases. Each step is
 * persisted before the next one, so an interrupted command (or a later
 * `continue` / `end`) resumes from the recorded point without repeating a
 * switch that already happened.
 */
export class MaintenanceRunner {
  private row!: MaintenanceRow;
  constructor(
    private readonly store: Store,
    private readonly config: MaintenanceConfig,
    private readonly driver: MaintenanceDriver,
    private readonly workFor: (
      operation: MaintenanceOperation,
    ) => MaintenanceWork = (operation) =>
      operation.kind === "command" ? commandWork(operation.argv) : manualWork,
  ) {}

  private target(id: string): MaintenanceHcTarget {
    const target = this.config.hc_targets.find((t) => t.id === id);
    if (!target) throw new Error(`maintenance.yaml 中没有 hc 目标 ${id}`);
    return target;
  }

  private async hcVersion(id: string): Promise<string | null> {
    const t = this.target(id);
    if (!t.link) return null;
    const result = await this.driver.run([
      ...t.via,
      t.via_shell ? shellQuote(t.link) : t.link,
      "--version",
    ]);
    const match = /^hc (\d+\.\d+\.\d+)\s*$/u.exec(result.stdout);
    return result.code === 0 && match ? (match[1] ?? null) : null;
  }

  private async coreVersion(id: string): Promise<string | null> {
    const argv = this.target(id).core_version;
    if (!argv) return null;
    const result = await this.driver.run(argv);
    const match = /(\d+\.\d+\.\d+)/u.exec(result.stdout);
    return result.code === 0 && match ? (match[1] ?? null) : null;
  }

  private save(
    phase: MaintenancePhase,
    change: (record: MaintenanceRecord) => MaintenanceRecord,
    note: string,
    notice?: string,
  ) {
    const at = this.driver.now();
    const record = withHistory(change(this.row.record), phase, note, at);
    this.row = updateMaintenance(this.store, this.row, phase, record, at);
    this.driver.audit(record, phase, note, notice);
  }

  /** Open a window and run it as far as it goes without the human. */
  async begin(start: MaintenanceStart): Promise<MaintenanceOutcome> {
    const now = this.driver.now();
    for (const id of start.stop_hc) this.target(id);
    const work = this.workFor(start.operation);
    const software = await this.driver.software();
    const hc: Record<string, string | null> = {};
    for (const t of this.config.hc_targets)
      hc[t.id] = await this.hcVersion(t.id);
    const timeout = start.timeout_ms ?? this.config.wait_timeout_ms;
    const record: MaintenanceRecord = {
      id: `M-${now.replace(/\D/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      reason: start.reason,
      operation: start.operation,
      stop_hc: [...start.stop_hc],
      started_at: now,
      wait: {
        timeout_ms: timeout,
        deadline: new Date(Date.parse(now) + timeout).toISOString(),
      },
      before: {
        software_sha: software.sha,
        server_process: software.process,
        deploy_pin: this.driver.deployPin(),
        hc,
      },
      rollback_scope: work.rollback_scope,
      steps: {},
      busy: [],
      history: [{ at: now, phase: "draining", note: "暂停派活和自动部署" }],
    };
    this.row = createMaintenance(this.store, record, now);
    this.driver.audit(
      record,
      "draining",
      "维护开始：已暂停新 Run 派发、检查准入和自动部署",
      `主机维护开始（${record.id}）：${start.reason}。已暂停新 Run 派发、检查和自动部署，等待在跑工作结束。`,
    );
    this.driver.say(
      `维护 ${record.id} 已开始；回退范围：${work.rollback_scope}`,
    );
    try {
      return await this.advance(work);
    } finally {
      releaseMaintenanceHolder(this.store);
    }
  }

  /** Pick up an open window: `proceed`/`wait` answer a drain timeout. */
  async resume(
    choice: "resume" | "proceed" | "wait" | "end",
  ): Promise<MaintenanceOutcome> {
    this.row = claimMaintenance(this.store, this.driver.now());
    try {
      const work = this.workFor(this.row.record.operation);
      const phase = this.row.phase;
      if (MAINTENANCE_TERMINAL.includes(phase))
        throw new Error(`维护 ${this.row.record.id} 已结束（${phase}）`);
      if (phase === "drain_timeout") {
        if (choice === "wait") {
          const now = this.driver.now();
          this.save(
            "draining",
            (r) => ({
              ...r,
              wait: {
                ...r.wait,
                deadline: new Date(
                  Date.parse(now) + r.wait.timeout_ms,
                ).toISOString(),
              },
            }),
            "人选择继续等待",
          );
        } else if (choice === "proceed") {
          const now = this.driver.now();
          const items = this.driver.activity().busy;
          this.save(
            "stopping",
            (r) => ({
              ...r,
              busy: items,
              wait: { ...r.wait, proceeded: { at: now, items } },
            }),
            `人选择不再等待，继续维护；未结束：${items.map(describeBusy).join("；") || "无"}`,
          );
        } else
          throw new Error(
            "等待已超时：用 maintenance continue --wait 继续等待，--proceed 不再等待继续维护，或 maintenance abandon 放弃",
          );
      } else if (phase === "stopped") {
        if (choice !== "end")
          throw new Error(
            "服务已停止，等待人工操作；完成后执行 maintenance end",
          );
        this.save("starting", (r) => r, "人工操作完成，开始恢复服务");
      } else if (phase === "recovery_required") {
        if (choice !== "end")
          throw new Error(
            "维护需要人工恢复：按 maintenance status 的恢复说明处理后执行 maintenance end 重新核对",
          );
        // Keep `error`: it records that the window failed, so a passing
        // re-check still ends as rolled_back, never as completed.
        this.save(
          "starting",
          (r) => {
            const { recovery: _r, ...rest } = r;
            return rest;
          },
          "人工恢复后重新核对",
        );
      } else if (choice === "proceed" || choice === "wait")
        throw new Error(`当前阶段 ${phase} 不是等待超时`);
      return await this.advance(work);
    } finally {
      releaseMaintenanceHolder(this.store);
    }
  }

  /** Give up before services stop: lift the gate, nothing else changed. */
  async abandon(): Promise<MaintenanceOutcome> {
    this.row = claimMaintenance(this.store, this.driver.now());
    try {
      if (!["draining", "drain_timeout"].includes(this.row.phase))
        throw new Error(
          `阶段 ${this.row.phase} 已停过服务，不能直接放弃；用 maintenance end 恢复服务并核对`,
        );
      this.save(
        "abandoned",
        (r) => r,
        "人放弃维护，未停服务，已恢复派活和自动部署",
        `主机维护 ${this.row.record.id} 已放弃：服务未停，派活、检查和自动部署已恢复。`,
      );
      return "abandoned";
    } finally {
      releaseMaintenanceHolder(this.store);
    }
  }

  private async advance(work: MaintenanceWork): Promise<MaintenanceOutcome> {
    for (;;) {
      const phase = this.row.phase;
      if (phase === "draining") {
        const outcome = await this.drain();
        if (outcome) return outcome;
      } else if (phase === "drain_timeout") return "drain_timeout";
      else if (phase === "stopping") await this.stopServices();
      else if (phase === "stopped") {
        this.driver.say(
          `服务已停止，可以开始人工维护；完成后执行 cardigan maintenance end（维护 ${this.row.record.id}）`,
        );
        return "stopped";
      } else if (phase === "operating") await this.operate(work);
      else if (phase === "starting") await this.start(work);
      else if (phase === "rolling_back") await this.rollBack(work);
      else if (phase === "recovery_required") return "recovery_required";
      else return phase as MaintenanceOutcome;
    }
  }

  private async drain(): Promise<MaintenanceOutcome | undefined> {
    let last = "";
    for (;;) {
      const { busy, standing } = this.driver.activity();
      const summary = busy.map(describeBusy).join("；");
      if (!busy.length) {
        this.save(
          "stopping",
          (r) => ({ ...r, busy: [] }),
          standing.length
            ? `在跑工作已结束；常驻会话不等待：${standing.map(describeBusy).join("；")}`
            : "在跑工作已结束",
        );
        return undefined;
      }
      if (summary !== last) {
        this.driver.say(`等待 ${busy.length} 项结束：${summary}`);
        last = summary;
      }
      if (
        Date.parse(this.driver.now()) >=
        Date.parse(this.row.record.wait.deadline)
      ) {
        this.save(
          "drain_timeout",
          (r) => ({ ...r, busy }),
          `等待超时，未结束：${summary}`,
          `主机维护 ${this.row.record.id} 等待超时，仍有 ${busy.length} 项未结束：${summary}。请决定继续等待（maintenance continue --wait）、不再等待（--proceed）或放弃（maintenance abandon）。`,
        );
        this.driver.say(
          "等待已超时，派活仍暂停。用 cardigan maintenance continue --wait 继续等待、--proceed 不等这些工作继续维护，或 cardigan maintenance abandon 放弃",
        );
        return "drain_timeout";
      }
      await this.driver.sleep(this.config.poll_interval_ms);
    }
  }

  private async mustRun(argv: readonly string[], what: string) {
    const result = await this.driver.run(argv);
    if (result.code !== 0)
      throw new Error(
        `${what}失败（退出码 ${result.code}）${result.stderr.trim().slice(0, 300)}`,
      );
  }

  private async portsClosed(): Promise<boolean> {
    const deadline =
      Date.parse(this.driver.now()) + this.config.server.ready_timeout_ms;
    for (;;) {
      const open = await Promise.all(
        this.config.server.ports.map((p) => this.driver.portOpen(p)),
      );
      if (!open.some(Boolean)) return true;
      if (Date.parse(this.driver.now()) >= deadline) return false;
      await this.driver.sleep(1000);
    }
  }

  private async stopServices() {
    const r = this.row.record;
    try {
      if (!r.steps.server_stopped) {
        await this.mustRun(this.config.server.stop, "停止 server ");
        if (!(await this.portsClosed()))
          throw new Error("server 停止后端口仍在监听");
        this.save(
          "stopping",
          (x) => ({ ...x, steps: { ...x.steps, server_stopped: true } }),
          "server 已停止",
        );
      }
      for (const id of r.stop_hc) {
        if (this.row.record.steps.hc_stopped?.includes(id)) continue;
        const stop = this.target(id).stop;
        if (!stop) throw new Error(`hc 目标 ${id} 没有配置 stop`);
        await this.mustRun(stop, `停止 hc ${id} `);
        this.save(
          "stopping",
          (x) => ({
            ...x,
            steps: {
              ...x.steps,
              hc_stopped: [...(x.steps.hc_stopped ?? []), id],
            },
          }),
          `hc ${id} 已停止`,
        );
      }
    } catch (error) {
      this.save(
        "starting",
        (x) => ({ ...x, error: message(error) }),
        `停服失败，恢复服务：${message(error)}`,
      );
      return;
    }
    this.save(
      r.operation.kind === "manual" ? "stopped" : "operating",
      (x) => x,
      "服务已停止",
    );
  }

  private context(): WorkContext {
    return {
      driver: this.driver,
      record: () => this.row.record,
      save: (change) => this.save(this.row.phase, change, "记录恢复点"),
    };
  }

  private async operate(work: MaintenanceWork) {
    try {
      await work.apply(this.context());
    } catch (error) {
      this.save(
        "rolling_back",
        (x) => ({
          ...x,
          error: message(error),
          steps: { ...x.steps, operation: "failed" },
        }),
        `维护操作失败，开始回退：${message(error)}`,
      );
      return;
    }
    this.save(
      "starting",
      (x) => ({ ...x, steps: { ...x.steps, operation: "done" } }),
      "维护操作完成",
    );
  }

  /** Start what this window stopped; empty when everything came back. */
  private async startServices(
    expected: Readonly<Record<string, string>> | undefined,
  ): Promise<string[]> {
    const problems: string[] = [];
    const r = this.row.record;
    for (const id of r.steps.hc_stopped ?? []) {
      const start = this.target(id).start;
      if (!start) continue;
      const result = await this.driver.run(start);
      if (result.code !== 0)
        problems.push(`hc ${id} 启动失败（退出码 ${result.code}）`);
    }
    if (r.steps.server_stopped) {
      const result = await this.driver.run(this.config.server.start);
      if (result.code !== 0)
        problems.push(`server 启动失败（退出码 ${result.code}）`);
    }
    if (problems.length) return problems;
    return this.verify(expected);
  }

  /** Ready, ports and versions; never treats an unknown as passed. */
  async verify(
    expected: Readonly<Record<string, string>> | undefined,
  ): Promise<string[]> {
    const r = this.row.record;
    const problems: string[] = [];
    const deadline =
      Date.parse(this.driver.now()) + this.config.server.ready_timeout_ms;
    let software: SoftwareState;
    let ports: boolean[];
    for (;;) {
      software = await this.driver.software();
      ports = await Promise.all(
        this.config.server.ports.map((p) => this.driver.portOpen(p)),
      );
      const fresh =
        !r.steps.server_stopped ||
        !r.before.server_process ||
        software.process !== r.before.server_process;
      if (
        (software.ready || !r.before.software_sha) &&
        fresh &&
        ports.every(Boolean)
      )
        break;
      if (Date.parse(this.driver.now()) >= deadline) break;
      await this.driver.sleep(2000);
    }
    if (r.before.software_sha && !software.ready)
      problems.push("server 未就绪");
    this.config.server.ports.forEach((port, i) => {
      if (!ports[i]) problems.push(`端口 ${port} 未监听`);
    });
    if (r.before.software_sha && software.sha !== r.before.software_sha)
      problems.push(
        `软件版本 ${software.sha ?? "未知"} 与维护前 ${r.before.software_sha} 不一致`,
      );
    for (const t of this.config.hc_targets) {
      const relevant =
        r.stop_hc.includes(t.id) || (expected && t.id in expected);
      if (!relevant) continue;
      const version = await this.hcVersion(t.id);
      const want = expected?.[t.id];
      if (t.link) {
        if (want ? version !== want : !isHcVersionCompatible(version))
          problems.push(
            `hc ${t.id} 版本 ${version ?? "未知"}${want ? `，应为 ${want}` : " 不兼容"}`,
          );
      }
      if (t.core_version) {
        const core = await this.coreVersion(t.id);
        const coreWant = want ?? version;
        if (!core || (coreWant && core !== coreWant))
          problems.push(
            `hc ${t.id} 运行中核心版本 ${core ?? "未知"}${coreWant ? `，应为 ${coreWant}` : ""}`,
          );
      }
    }
    return problems;
  }

  private recoveryText(problems: readonly string[]): string[] {
    const r = this.row.record;
    const lines = [
      `未通过的核对：${problems.join("；")}`,
      `server 启动命令：${this.config.server.start.join(" ")}`,
    ];
    for (const id of r.steps.hc_stopped ?? []) {
      const start = this.target(id).start;
      if (start) lines.push(`hc ${id} 启动命令：${start.join(" ")}`);
    }
    for (const [id, previous] of Object.entries(r.steps.switched ?? {})) {
      const link = this.target(id).link;
      lines.push(
        previous.kind === "symlink"
          ? `如需回到维护前的 hc：把 ${link} 指回 ${previous.target}`
          : `如需回到维护前的 hc：用备份 ${previous.backup} 覆盖 ${link}`,
      );
    }
    lines.push(
      "派活、检查和自动部署保持暂停。处理后执行 cardigan maintenance end 重新核对，通过才恢复。",
    );
    return lines;
  }

  private async start(work: MaintenanceWork) {
    const r = this.row.record;
    const rolledBack = r.steps.operation === "failed";
    // Only an applied operation is checked against its targets. Before it
    // ran (stopping failed, manual window) or after it was put back, each
    // switched target must be on its version from before the window and the
    // rest only compatible.
    const expected =
      r.steps.operation === "done" ? work.expected_hc : beforeVersions(r);
    const problems = await this.startServices(expected);
    if (!problems.length) {
      const failed = rolledBack || !!r.error;
      const outcome: MaintenancePhase = failed ? "rolled_back" : "completed";
      const pin = this.driver.deployPin();
      const pinNote =
        pin === r.before.deploy_pin
          ? ""
          : `；部署固定已变为 ${pin ?? "无"}，请核对`;
      this.save(
        outcome,
        (x) => x,
        failed ? "已回退到维护前状态" : "维护完成",
        failed
          ? `主机维护 ${r.id} 失败并已回退：${r.error ?? "维护操作失败"}。服务已按维护前状态恢复并核对，派活、检查和自动部署已恢复${pinNote}。`
          : `主机维护 ${r.id} 已完成：服务已启动并核对就绪、端口和版本，派活、检查和自动部署已恢复${pinNote}。`,
      );
      this.driver.say(
        failed
          ? `维护失败，已回退：${r.error ?? ""}`
          : "维护完成，已恢复派活和自动部署",
      );
      return;
    }
    if (!rolledBack && r.steps.operation === "done" && r.steps.switched) {
      this.save(
        "rolling_back",
        (x) => ({
          ...x,
          error: `升级后核对未通过：${problems.join("；")}`,
          steps: { ...x.steps, operation: "failed" },
        }),
        `核对未通过，开始回退：${problems.join("；")}`,
      );
      return;
    }
    this.requireRecovery(problems);
  }

  private requireRecovery(problems: readonly string[]) {
    const recovery = this.recoveryText(problems);
    this.save(
      "recovery_required",
      (x) => ({ ...x, recovery }),
      `需要人工恢复：${problems.join("；")}`,
      `主机维护 ${this.row.record.id} 未能自动恢复，派活、检查和自动部署保持暂停。${recovery.join(" ")}`,
    );
    this.driver.say(["需要人工恢复：", ...recovery].join("\n"));
  }

  private async rollBack(work: MaintenanceWork) {
    const r = this.row.record;
    try {
      // Stop again anything that may have come up before the failure.
      if (r.steps.server_stopped)
        await this.mustRun(this.config.server.stop, "回退前停止 server ");
      for (const id of r.steps.hc_stopped ?? []) {
        const stop = this.target(id).stop;
        if (stop) await this.mustRun(stop, `回退前停止 hc ${id} `);
      }
      await work.rollback(this.context());
    } catch (error) {
      this.requireRecovery([`回退失败：${message(error)}`]);
      return;
    }
    this.save("starting", (x) => x, "已恢复维护前的 hc，重新启动服务");
  }
}

function beforeVersions(r: MaintenanceRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of Object.keys(r.steps.switched ?? {})) {
    const v = r.before.hc[id];
    if (v) out[id] = v;
  }
  return out;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** POSIX single quotes for a `via_shell` prefix such as ssh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function maintenanceStatus(store: Store): string {
  const row = readMaintenance(store);
  if (!row) return "当前没有维护";
  const r = row.record;
  const lines = [
    `维护 ${r.id}：${row.phase}${row.held ? "（有命令正在执行）" : ""}`,
    `原因：${r.reason}`,
    `操作：${r.operation.kind === "hc_upgrade" ? `hc 升级到 ${r.operation.version}` : r.operation.kind === "command" ? r.operation.argv.join(" ") : "人工操作"}`,
    `开始：${r.started_at}；等待截止：${r.wait.deadline}`,
    `回退范围：${r.rollback_scope}`,
    `维护前：软件 ${r.before.software_sha ?? "未知"}；部署固定 ${r.before.deploy_pin ?? "无"}；hc ${
      Object.entries(r.before.hc)
        .map(([k, v]) => `${k}=${v ?? "未知"}`)
        .join(" ") || "无"
    }`,
  ];
  if (r.busy.length)
    lines.push(
      `未结束：${r.busy.map((b: MaintenanceBusyItem) => describeBusy(b)).join("；")}`,
    );
  if (r.error) lines.push(`错误：${r.error}`);
  if (r.recovery) lines.push("恢复说明：", ...r.recovery);
  const last = r.history.at(-1);
  if (last) lines.push(`最近：${last.at} ${last.note}`);
  return lines.join("\n");
}
