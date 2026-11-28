import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  activeOwner,
  type Clock,
  DEFAULT_MAX_RUN_LIMIT,
  type MemberId,
  saveMachine,
  setRunLimit,
} from "@cardigan/domain";
import {
  commitWorkerFile,
  deviceInitPlan,
  deviceInitScript,
  effectiveRunLimit,
  explicitMcpUrl,
  loadMachineCapabilityCatalog,
  loadRuntimeWorkers,
  type MachineCheckJournal,
  parseWorkerOnboarding,
  planWorkerFile,
  runCapacityMachines,
  suggestedForGpu,
  type WizardFilePlan,
  WorkerOnboardingError,
  workerDraftForm,
  workerDraftLayout,
  workerMcpConfig,
  workerPublicKey,
  workerWizardForm,
} from "@cardigan/host";
import { persistEffect } from "@cardigan/mcp-server";
import {
  deleteWorkerWizardSession,
  listWorkerWizardSessions,
  persistRunLimitEffect,
  type ReadRepositories,
  readRunLimit,
  type Store,
  type StoreTransactionContext,
  saveWorkerWizardSession,
  type WebSession,
} from "@cardigan/store";
import {
  type DevicePairings,
  type PairingDevice,
  pairingForm,
} from "./device-pairings.js";
import { machineObservationView } from "./execution-state.js";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";
import { machineAudit } from "./machine-checks.js";
import type { WizardHost } from "./machine-host.js";
import { emptyState } from "./sql-state.js";
import {
  checkRegistryCompatibility,
  checkWizard,
  type Draft,
  initialSteps,
  isRegistered,
  type StepRecord,
} from "./worker-wizard-check.js";

interface Session {
  id: string;
  project: string;
  machine: string;
  member: string;
  draft: Draft;
  priorDigest: string | undefined;
  expires: number;
  phase: "preview" | "ready" | "running" | "failed" | "passed" | "enabled";
  preview?: { id: string; expires: number; plan: WizardFilePlan };
  steps: StepRecord[];
  check_id?: string;
  error?: string;
  /**
   * C-846: started from a registered machine's detail page with the draft
   * it already has; enabling remote launch also puts the machine online.
   */
  origin?: "machine";
  /** C-706: the device pairing this draft came from and its initialisation. */
  pairing?: {
    id: string;
    init: "waiting" | "fetched" | "succeeded" | "failed";
    at?: string;
    /** C-707: what the device reported about itself when pairing. */
    device: PairingDevice;
    /**
     * C-707: the Agent limit chosen when confirming the code, set when the
     * check first registers the machine: `applied`, or `kept` when the machine
     * was already known on this host (its limit stays as it is).
     */
    run_limit: { value: number; state: "pending" | "applied" | "kept" };
    /** The registration wrote the limit (checked again when the check ends). */
    limit_written?: boolean;
  };
}
/**
 * C-707: the onboarding report's host-side facts: capabilities observed for
 * this machine and project, and catalog tools for its system not verified yet.
 */
interface Report {
  capabilities: {
    key: string;
    version: string | null;
    verified_at: string | null;
    state: string;
  }[];
  suggested: string[];
}
const stale = () =>
  new HttpRejection(
    409,
    "worker_preview_stale",
    "预览已过期或状态已改变，请重新核对。",
  );
const missing = () => new HttpRejection(404, "not_found", "没有此向导会话");
/** C-707: the code stays usable; the reply names the field to correct. */
const runLimitInvalid = (maximum: number | undefined) =>
  new HttpRejection(
    400,
    "worker_run_limit_invalid",
    maximum === undefined ? "名额须为正整数" : `名额须为 1～${maximum} 的整数`,
    maximum === undefined ? undefined : { maximum },
  );
const invalid = () =>
  new HttpRejection(400, "validation_failed", "向导参数无效");
const safeError = (e: unknown) =>
  e instanceof WorkerOnboardingError ? e.code : "worker_operation_failed";
const preview = (plan: WizardFilePlan, now: number) => ({
  id: randomUUID(),
  expires: now + 15 * 60_000,
  plan,
});
/** C-846: a machine id as the wizard form accepts it. */
const MACHINE_ID = "[A-Za-z0-9][A-Za-z0-9._-]{0,79}";
/** C-846: the persisted form of a session; the parsed config is rebuilt on load. */
function stored(s: Session) {
  const { draft, preview: p, ...rest } = s;
  return {
    version: 1,
    ...rest,
    draft: { label: draft.label, raw: draft.raw, commands: draft.commands },
    ...(p
      ? {
          preview: {
            id: p.id,
            expires: p.expires,
            plan: {
              name: p.plan.name,
              revision: p.plan.revision,
              bytes: p.plan.bytes.toString("base64"),
              guardName: p.plan.guardName,
              guardRevision: p.plan.guardRevision,
              diff: p.plan.diff,
              priorDigest: p.plan.binding.priorDigest ?? null,
            },
          },
        }
      : {}),
  };
}
const PHASES = ["preview", "ready", "running", "failed", "passed", "enabled"];
/**
 * C-846: a session read back after a restart. The configuration is parsed
 * again under this host's data directory; a check that was running when the
 * server stopped did not finish, so the session continues from its failure.
 */
function restored(doc: unknown, dataDir: string): Session | undefined {
  type Doc = Omit<Session, "draft" | "preview"> & {
    version: number;
    draft: { label: string; raw: unknown; commands: Draft["commands"] };
    preview?: {
      id: string;
      expires: number;
      plan: Omit<WizardFilePlan, "binding" | "bytes"> & {
        bytes: string;
        priorDigest: string | null;
      };
    };
  };
  const d = doc as Doc;
  if (
    d?.version !== 1 ||
    typeof d.id !== "string" ||
    typeof d.project !== "string" ||
    typeof d.machine !== "string" ||
    typeof d.member !== "string" ||
    typeof d.expires !== "number" ||
    !PHASES.includes(d.phase) ||
    !Array.isArray(d.steps) ||
    typeof d.draft?.label !== "string"
  )
    return undefined;
  const config = parseWorkerOnboarding(d.draft.raw, dataDir);
  if (
    config.worker.machine_id !== d.machine ||
    config.worker.project_id !== d.project
  )
    return undefined;
  const { version: _version, draft, preview: p, ...rest } = d;
  const s: Session = {
    ...rest,
    draft: {
      label: draft.label,
      raw: draft.raw as Draft["raw"],
      config,
      commands: draft.commands,
    },
    ...(p
      ? {
          preview: {
            id: p.id,
            expires: p.expires,
            plan: {
              binding: {
                config,
                dataDir,
                priorDigest: p.plan.priorDigest ?? undefined,
              },
              name: p.plan.name,
              revision: p.plan.revision,
              bytes: Buffer.from(p.plan.bytes, "base64"),
              guardName: p.plan.guardName,
              guardRevision: p.plan.guardRevision,
              diff: p.plan.diff,
            },
          },
        }
      : {}),
  };
  if (s.phase === "running") {
    s.phase = "failed";
    s.error = "worker_check_interrupted";
    s.steps = s.steps.map((step) =>
      step.state === "running" ? { ...step, state: "pending" } : step,
    );
  }
  return s;
}
/**
 * C-565: the HTTPS `/mcp` address to prefill the form with, from validated
 * host configuration only: this project's remote bindings first, else one
 * address all bindings share, else an explicit `CARDIGAN_MCP_URL` that
 * passes the same remote-worker check (a loopback listener address never
 * does). Nothing when the file is invalid or the bindings disagree.
 */
function knownMcpUrl(
  host: WizardHost,
  project: string,
): { mcp_url: string; mcp_source: "workers" | "host" } | undefined {
  let workers: ReturnType<typeof loadRuntimeWorkers>;
  try {
    workers = loadRuntimeWorkers(
      host.dataDir,
      join(host.root, "runtime-workers.yaml"),
    );
  } catch {
    return undefined;
  }
  const urls = (list: typeof workers) => [
    ...new Set(
      list.flatMap((w) => (w.execution.mcp ? [w.execution.mcp.url] : [])),
    ),
  ];
  const own = urls(workers.filter((w) => w.project_id === project));
  const all = urls(workers);
  const bound = own.length > 0 ? own : all;
  if (bound.length === 1 && bound[0])
    return { mcp_url: bound[0], mcp_source: "workers" };
  if (bound.length > 1) return undefined;
  try {
    const explicit = explicitMcpUrl(host.env);
    return explicit
      ? { mcp_url: workerMcpConfig(explicit).url, mcp_source: "host" }
      : undefined;
  } catch {
    return undefined;
  }
}
function view(s: Session, report?: Report) {
  return {
    id: s.id,
    machine_id: s.machine,
    project_id: s.project,
    label: s.draft.label,
    os: s.draft.config.worker.os,
    arch: s.draft.config.worker.arch,
    phase: s.phase,
    steps: s.steps,
    commands: s.draft.commands,
    // C-843: the report shows the free space of the volume holding it.
    work_root: s.draft.config.worker.execution.agentRoot,
    command_guide:
      s.draft.config.worker.os === "darwin"
        ? "docs/macos-worker.md"
        : // C-709: a read-only root (SteamOS) keeps the work root and release under /home.
          s.draft.config.worker.execution.agentRoot.startsWith(
              "/home/cardigan-workers/",
            )
          ? "docs/steamos-worker.md"
          : "docs/linux-worker.md",
    command_prerequisites:
      "仅在目标机管理员终端执行。新建账号前核对名称和数字身份均空闲；按操作手册准备受保护的安装包、目录、认领标记和本机安装配置，Mac 先安装并核验签名 App。已有冲突请停下核对。",
    check_id: s.check_id,
    error: s.error,
    ...(s.pairing
      ? {
          device_init: { state: s.pairing.init, at: s.pairing.at },
          device: s.pairing.device,
          run_limit: s.pairing.run_limit,
        }
      : {}),
    ...(report ? { report } : {}),
    ...(s.preview
      ? {
          preview: {
            preview_id: s.preview.id,
            expires_at: new Date(s.preview.expires).toISOString(),
            file: s.preview.plan.name,
            diff: s.preview.plan.diff,
          },
        }
      : {}),
  };
}
export class WorkerWizards {
  private sessions = new Map<string, Session>();
  private pending = new Set<Promise<void>>();
  constructor(
    private store: Store,
    private clock: Clock,
    private checks: MachineCheckJournal,
    private signal: AbortSignal,
    private host: WizardHost | undefined,
    private limit?: ((id: string) => number) | undefined,
    private max?: ((id: string) => number) | undefined,
    private pairings?: DevicePairings | undefined,
  ) {
    this.load();
    pairings?.attach({
      state: (id) => {
        const s = this.sessions.get(id);
        if (!s?.pairing || this.signal.aborted) return "unavailable";
        if (s.pairing.init === "succeeded") return "succeeded";
        return s.phase === "preview" ? "waiting" : "ready";
      },
      script: (id) => this.deviceScript(id),
      completed: (id, ok) => this.deviceCompleted(id, ok),
    });
  }
  /** C-846: sessions kept before the last restart, minus expired ones. */
  private load() {
    const host = this.host;
    if (!host || this.signal.aborted) return;
    const now = Date.parse(this.clock.now());
    for (const row of listWorkerWizardSessions(this.store.database)) {
      let s: Session | undefined;
      try {
        s = restored(row.doc, host.dataDir);
      } catch {
        s = undefined;
      }
      if (!s || s.id !== row.id || s.expires <= now) {
        deleteWorkerWizardSession(this.store.database, row.id);
        continue;
      }
      this.sessions.set(s.id, s);
    }
  }
  /** C-846: record the session as it is now. */
  private save(s: Session) {
    if (this.sessions.get(s.id) !== s) return;
    this.store.uow.run(() =>
      saveWorkerWizardSession(this.store.database, {
        id: s.id,
        project_id: s.project,
        expires_at: s.expires,
        doc: stored(s),
      }),
    );
  }
  /** C-846: forget a session here and in the database. */
  private drop(id: string) {
    this.sessions.delete(id);
    this.store.uow.run(() =>
      deleteWorkerWizardSession(this.store.database, id),
    );
  }
  /** A live paired session, or the device's view of why not. */
  private paired(id: string) {
    const s = this.sessions.get(id);
    if (
      !s?.pairing ||
      !this.host ||
      this.signal.aborted ||
      (s.expires <= Date.parse(this.clock.now()) && s.phase !== "running")
    )
      throw new HttpRejection(
        410,
        "device_init_unavailable",
        "向导草稿已取消或过期，请重新配对。",
      );
    return { s, pairing: s.pairing, host: this.host };
  }
  /**
   * C-706: the one-time init script of a confirmed draft. Only the confirmed
   * configuration and the host's public key go in; no token or credential.
   */
  private deviceScript(id: string) {
    const { s, pairing, host } = this.paired(id);
    if (s.phase === "preview")
      throw new HttpRejection(
        409,
        "device_init_not_ready",
        "请先在 Workbench 向导里确认写入配置。",
      );
    if (pairing.init === "succeeded")
      throw new HttpRejection(409, "device_init_reported", "本机已完成初始化");
    let script: string;
    try {
      script = deviceInitScript(
        deviceInitPlan(s.draft.config, workerPublicKey(host.root)),
      );
    } catch (e) {
      const code = safeError(e);
      throw new HttpRejection(
        409,
        code === "worker_public_key_invalid"
          ? "device_init_public_key_missing"
          : "device_init_unsupported",
        code === "worker_public_key_invalid"
          ? "控制主机配置目录里没有可用的 worker-key.pub（Ed25519 公钥），请在控制主机补上后重试。"
          : "这份向导配置不能生成初始化脚本，请按操作手册手工准备。",
      );
    }
    if (pairing.init === "waiting") {
      pairing.init = "fetched";
      this.save(s);
    }
    return script;
  }
  /**
   * C-706: the device ran its script. Record it and, on success, start the
   * wizard's recheck as the owner who confirmed the draft (still checked to
   * be the active owner); the check itself verifies everything over SSH.
   */
  private deviceCompleted(id: string, ok: boolean): "started" | "skipped" {
    const { s, pairing } = this.paired(id);
    if (pairing.init === "succeeded")
      throw new HttpRejection(409, "device_init_reported", "本机已完成初始化");
    if (pairing.init === "waiting")
      throw new HttpRejection(
        409,
        "device_init_not_ready",
        "尚未取得初始化脚本",
      );
    pairing.init = ok ? "succeeded" : "failed";
    pairing.at = this.clock.now();
    this.save(s);
    this.store.uow.run((tx) =>
      machineAudit(tx, this.clock, "worker_wizard_device_initialized", {
        member_id: s.member,
        project_id: s.project,
        machine_id: s.machine,
        wizard_id: s.id,
        pairing_id: pairing.id,
        ok,
      }),
    );
    if (!ok || (s.phase !== "ready" && s.phase !== "failed")) return "skipped";
    const owner = (tx?: ReadRepositories) => {
      const current = tx
        ? activeOwner(tx.members.list())?.id
        : this.store.uow.read((t) => activeOwner(t.members.list())?.id);
      if (current !== s.member)
        throw new HttpRejection(403, "unauthorized", "仅限当前所有者");
      return s.member;
    };
    try {
      this.startCheck(s, owner);
      return "started";
    } catch {
      return "skipped";
    }
  }
  /**
   * C-707: the chosen Agent limit, in the transaction that first registers a
   * paired machine. A machine some project already has keeps its limit, and
   * so does one with a saved limit: onboarding never changes a machine that
   * is already working.
   */
  private registered(s: Session) {
    return (tx: StoreTransactionContext, first: boolean) => {
      const pairing = s.pairing;
      const wanted = pairing?.run_limit;
      if (!pairing || wanted?.state !== "pending") return;
      // Also a machine some project ran work on without registering it
      // (a legacy executor) keeps its limit.
      if (
        !first ||
        readRunLimit(this.store.database, s.machine) ||
        this.store
          .listProjects()
          .some((p) =>
            tx.assignments.list(p.id).some((a) => a.machine_id === s.machine),
          )
      )
        return;
      const result = setRunLimit(
        { kind: "human", project_id: s.project },
        { machine_id: s.machine, limit: wanted.value },
        {
          machines: runCapacityMachines(this.store, tx),
          previous: effectiveRunLimit(
            this.store,
            s.machine,
            this.limit,
            this.max,
          ),
          maximum: this.max?.(s.machine) ?? DEFAULT_MAX_RUN_LIMIT,
          member_id: s.member as MemberId,
          clock: this.clock,
          ids: tx.global_ids,
        },
      );
      // Only a hint: a limit the host refuses leaves its default in place.
      if (!result.ok) return;
      persistRunLimitEffect(this.store.database, tx, result.value);
      // The outcome is read back once the check ends: this transaction may
      // still roll back.
      pairing.limit_written = true;
    };
  }
  /** C-707: the report once the checks passed; owner-only like the view. */
  private report(s: Session): Report | undefined {
    if (!this.host || (s.phase !== "passed" && s.phase !== "enabled"))
      return undefined;
    const os = s.draft.config.worker.os;
    let declared: string[] = [];
    try {
      declared = loadMachineCapabilityCatalog(this.host.env, undefined, os)
        .filter((c) => c.os.some((o) => o === os))
        .map((c) => c.key);
    } catch {
      // An invalid catalog only leaves the suggestions empty.
    }
    const now = this.clock.now();
    return this.store.uow.read((tx) => {
      const machine = tx.machines.get(s.project, s.machine);
      if (!machine) return undefined;
      const { capabilities } = machineObservationView(
        this.store,
        s.project,
        machine,
        now,
        declared,
      );
      return {
        capabilities: capabilities.map(
          ({ key, version, verified_at, state }) => ({
            key,
            version,
            verified_at,
            state,
          }),
        ),
        suggested: capabilities
          .filter(
            (c) =>
              c.state !== "verified" &&
              declared.includes(c.key) &&
              // C-843: no NVIDIA tools for an AMD GPU.
              suggestedForGpu(c.key, s.pairing?.device.gpu),
          )
          .map((c) => c.key),
      };
    });
  }
  private view(s: Session) {
    return view(s, this.report(s));
  }
  /** Start the wizard's checks for a ready, failed or passed session. */
  private startCheck(s: Session, authorize: (tx?: ReadRepositories) => string) {
    const host = this.host;
    if (!host || !["ready", "failed", "passed"].includes(s.phase))
      throw stale();
    const steps = s.phase === "passed" ? initialSteps() : s.steps;
    const check = checkWizard({
      store: this.store,
      checks: this.checks,
      clock: this.clock,
      host,
      signal: this.signal,
      draft: s.draft,
      steps,
      priorDigest: s.priorDigest,
      authorize,
      limit: effectiveRunLimit(this.store, s.machine, this.limit, this.max),
      id: s.id,
      onRegistered: this.registered(s),
    });
    s.steps = steps;
    s.check_id = check.id;
    s.phase = "running";
    delete s.preview;
    delete s.error;
    this.save(s);
    // After the server began closing the store may be gone; the session is
    // then read back as interrupted.
    const record = () => {
      try {
        this.save(s);
      } catch {
        // Only resuming after a restart depends on it.
      }
    };
    const done = check.done.then(
      (ok) => {
        s.phase = ok ? "passed" : "failed";
        // Applied only when the registration that wrote it committed;
        // otherwise the machine was known before and keeps its limit. A
        // failed round leaves it pending for the next one.
        const pairing = s.pairing;
        if (ok && pairing?.run_limit.state === "pending")
          pairing.run_limit.state =
            pairing.limit_written &&
            readRunLimit(this.store.database, s.machine)?.limit ===
              pairing.run_limit.value
              ? "applied"
              : "kept";
        record();
      },
      (e) => {
        s.phase = "failed";
        s.error = safeError(e);
        record();
      },
    );
    this.pending.add(done);
    void done.then(() => this.pending.delete(done));
  }
  /** Expired sessions are dropped unless a check still runs. */
  private expire(now: number) {
    for (const [key, s] of this.sessions)
      if (s.expires <= now && s.phase !== "running") this.drop(key);
  }
  /**
   * The same draft, checks and preview as a form typed into the wizard.
   * C-846: a draft already written for this binding keeps its layout (a
   * SteamOS work root under /home), and a session started from a machine's
   * detail page continues that written draft without a new preview.
   */
  private create(
    host: WizardHost,
    project: string,
    member: string,
    form: Record<string, unknown>,
    now: number,
    audit: (type: string, s: Session) => void,
    origin?: "machine",
  ) {
    let draft = workerWizardForm(host.root, host.dataDir, project, form);
    const machine = draft.config.worker.machine_id;
    if (
      form.layout === undefined &&
      draft.config.worker.os === "linux" &&
      workerDraftLayout(host.root, project, machine) === "home"
    )
      draft = workerWizardForm(host.root, host.dataDir, project, {
        ...form,
        layout: "home",
      });
    this.store.uow.read((tx) =>
      checkRegistryCompatibility(this.store, tx, draft),
    );
    const plan = planWorkerFile(
      host.root,
      host.dataDir,
      draft.raw,
      draft.config,
    );
    // Continuing a written draft changes nothing in it.
    if (origin && plan.diff.length > 0)
      throw new WorkerOnboardingError("worker_config_conflict");
    const { priorDigest } = plan.binding;
    if (priorDigest && priorDigest !== draft.config.digest)
      plan.diff.push({ field: "completed_checks", change: "reset" });
    for (const s of this.sessions.values())
      if (
        s.project === project &&
        s.machine === machine &&
        s.member === member
      ) {
        if (s.phase === "running") throw stale();
        this.drop(s.id);
      }
    if (this.sessions.size >= 64)
      throw new HttpRejection(429, "capacity", "向导会话已满");
    const s: Session = {
      id: randomUUID(),
      machine,
      project,
      member,
      draft,
      priorDigest,
      expires: now + 86400_000,
      phase: origin ? "ready" : "preview",
      steps: initialSteps(),
      ...(origin ? { origin } : { preview: preview(plan, now) }),
    };
    audit(origin ? "machine_resumed" : "previewed", s);
    this.sessions.set(s.id, s);
    this.save(s);
    return s;
  }
  /**
   * C-846: enabling remote launch from a machine's detail page also puts a
   * freshly onboarded (offline) machine online for this project, in the same
   * transaction. A drained or degraded machine keeps its status.
   */
  private online(tx: StoreTransactionContext, s: Session) {
    const m = tx.machines.get(s.project, s.machine);
    if (m?.status !== "offline") return;
    const effect = saveMachine(
      { ...emptyState(tx, s.project), machines: [m] },
      { kind: "human", project_id: s.project },
      { machine: { ...m, status: "online" }, operation: "update" },
      { clock: this.clock, ids: tx.ids },
    );
    if (!effect.ok)
      throw new HttpRejection(409, effect.error.code, effect.error.message);
    persistEffect(tx, s.project, effect.value);
  }
  /**
   * C-846: a registered machine whose wizard draft is written: `GET` says
   * whether remote launch can be enabled from its detail page, `POST` starts
   * the wizard's checks on that draft; the launch preview and enabling then
   * go through the session like any other.
   */
  private async serveMachine(
    req: IncomingMessage,
    res: ServerResponse,
    project: string,
    machine: string,
    authorize: (tx?: ReadRepositories) => string,
    host: WizardHost,
  ) {
    const read = req.method === "GET";
    if (!read && req.method !== "POST") methodNotAllowed(["GET", "POST"]);
    if (!read && Object.keys(await readJsonBody(req)).length > 0)
      throw invalid();
    const member = authorize(),
      now = Date.parse(this.clock.now());
    this.expire(now);
    const label =
      machine === "local"
        ? undefined
        : this.store.uow.read((tx) => tx.machines.get(project, machine)?.label);
    if (label === undefined) throw missing();
    const enabled = () =>
      loadRuntimeWorkers(
        host.dataDir,
        join(host.root, "runtime-workers.yaml"),
      ).some(
        (w) =>
          w.machine_id === machine &&
          w.project_id === project &&
          w.allow_remote_launch,
      );
    const draft = () =>
      workerDraftForm(host.root, host.dataDir, project, machine, label);
    if (read) {
      let state: "enabled" | "available" | "unavailable";
      try {
        state = enabled() ? "enabled" : draft() ? "available" : "unavailable";
      } catch {
        state = "unavailable";
      }
      return sendJson(res, 200, { remote_launch: state });
    }
    try {
      if (enabled())
        throw new HttpRejection(
          409,
          "worker_already_enabled",
          "这台机器已开启远程派发",
        );
      const form = draft();
      if (!form)
        throw new HttpRejection(
          404,
          "worker_draft_missing",
          "这台机器没有向导写入的接入配置，请用“添加 worker”接入。",
        );
      const running = [...this.sessions.values()].find(
        (s) =>
          s.project === project &&
          s.machine === machine &&
          s.member === member &&
          s.phase === "running",
      );
      if (running) return sendJson(res, 200, { wizard: this.view(running) });
      const s = this.create(
        host,
        project,
        member,
        form,
        now,
        (type, s) =>
          this.store.uow.run((tx) =>
            machineAudit(tx, this.clock, `worker_wizard_${type}`, {
              member_id: member,
              project_id: project,
              machine_id: s.machine,
              wizard_id: s.id,
            }),
          ),
        "machine",
      );
      this.startCheck(s, authorize);
      return sendJson(res, 202, { wizard: this.view(s) });
    } catch (e) {
      throw rejection(e);
    }
  }
  async settled() {
    await Promise.allSettled(this.pending);
  }
  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    project: string,
    rest: string,
    session: () => WebSession,
  ) {
    const authorize = (tx?: ReadRepositories) => {
      if (req.headers.authorization !== undefined)
        throw new HttpRejection(403, "unauthorized", "仅限人类登录会话");
      const member = session().member_id;
      if (
        !member ||
        (tx
          ? activeOwner(tx.members.list())?.id
          : this.store.uow.read((tx) => activeOwner(tx.members.list())?.id)) !==
          member
      )
        throw new HttpRejection(403, "unauthorized", "仅限当前所有者");
      return member;
    };
    authorize();
    const host = this.host;
    if (!host || this.signal.aborted)
      throw new HttpRejection(503, "unavailable", "向导服务不可用");
    if (rest === "/worker-wizards/defaults") {
      if (req.method !== "GET") methodNotAllowed(["GET"]);
      return sendJson(res, 200, {
        defaults: knownMcpUrl(host, project) ?? {},
      });
    }
    // C-846: `/worker-wizards/machines/<id>` continues a registered
    // machine's written draft from its detail page.
    const registered = new RegExp(
      `^/worker-wizards/machines/(${MACHINE_ID})$`,
      "u",
    ).exec(rest)?.[1];
    if (registered !== undefined)
      return this.serveMachine(req, res, project, registered, authorize, host);
    // C-705: `/worker-wizards/pairing` turns a device pairing code into a draft.
    const pairing = rest === "/worker-wizards/pairing";
    const match = pairing
      ? []
      : /^\/worker-wizards(?:\/([a-f0-9-]{36})(?:\/(confirm|run|cancel|launch-preview|enable))?)?$/.exec(
          rest,
        );
    if (!match) throw missing();
    const [, id, action] = match,
      read = !!id && !action;
    if (req.method !== (read ? "GET" : "POST"))
      methodNotAllowed([read ? "GET" : "POST"]);
    const body = read ? {} : await readJsonBody(req);
    const member = authorize(),
      now = Date.parse(this.clock.now());
    this.expire(now);
    const audit = (type: string, s: Session) =>
      this.store.uow.run((tx) =>
        machineAudit(tx, this.clock, `worker_wizard_${type}`, {
          member_id: member,
          project_id: project,
          machine_id: s.machine,
          wizard_id: s.id,
        }),
      );
    const create = (form: Record<string, unknown>) =>
      this.create(host, project, member, form, now, audit);
    try {
      if (pairing) {
        if (
          !this.pairings ||
          Object.keys(body).some((k) => k !== "code" && k !== "run_limit")
        )
          throw invalid();
        // C-707: the Agent limit for a new machine, 1 unless chosen.
        const runLimit = "run_limit" in body ? body.run_limit : 1;
        if (
          typeof runLimit !== "number" ||
          !Number.isSafeInteger(runLimit) ||
          runLimit < 1
        )
          throw runLimitInvalid(undefined);
        // Look up, create and claim in one synchronous turn: of two
        // submissions of one code only the first gets a draft.
        const found = this.pairings.lookup(body.code, member);
        const form = pairingForm(
          found.device,
          project,
          knownMcpUrl(host, project)?.mcp_url,
        );
        const maximum = this.max?.(form.machine_id) ?? DEFAULT_MAX_RUN_LIMIT;
        if (runLimit > maximum) throw runLimitInvalid(maximum);
        let s: Session;
        try {
          s = create(form);
        } catch (e) {
          // The code stays usable; the device facts let the owner fill the
          // wizard by hand instead.
          const code = safeError(e);
          throw new HttpRejection(
            e instanceof HttpRejection
              ? e.status
              : code === "worker_form_invalid" ||
                  code === "worker_config_invalid"
                ? 400
                : 409,
            e instanceof HttpRejection ? e.code : code,
            e instanceof HttpRejection
              ? e.message
              : "配对设备的信息不能直接生成向导草稿，请在向导里补全后预览。",
            { form },
          );
        }
        this.pairings.claim(found, s.id);
        s.pairing = {
          id: found.id,
          init: "waiting",
          device: found.device,
          run_limit: { value: runLimit, state: "pending" },
        };
        this.save(s);
        this.store.uow.run((tx) =>
          machineAudit(tx, this.clock, "worker_wizard_pairing_claimed", {
            member_id: member,
            project_id: project,
            machine_id: s.machine,
            wizard_id: s.id,
            pairing_id: found.id,
          }),
        );
        return sendJson(res, 201, {
          wizard: this.view(s),
          device: found.device,
        });
      }
      if (!id) return sendJson(res, 201, { wizard: this.view(create(body)) });
      const s = this.sessions.get(id);
      if (!s || s.member !== member || s.project !== project) throw missing();
      if (read) return sendJson(res, 200, { wizard: this.view(s) });
      const keys =
        action === "enable"
          ? ["allow_remote_launch", "preview_id"]
          : action === "confirm"
            ? ["preview_id"]
            : [];
      // C-565: an automatic recheck names the failed check it continues.
      const optional = action === "run" ? ["resume_check_id"] : [];
      if (
        Object.keys(body).some(
          (k) => !keys.includes(k) && !optional.includes(k),
        ) ||
        keys.some((k) => !(k in body)) ||
        ("resume_check_id" in body && typeof body.resume_check_id !== "string")
      )
        throw invalid();
      // An automatic recheck only continues the failed check it saw; if the
      // session moved on (another page continued, is checking or passed it),
      // it must read the current state instead of starting a new check.
      if (
        "resume_check_id" in body &&
        (s.phase !== "failed" || s.check_id !== body.resume_check_id)
      )
        throw new HttpRejection(
          409,
          "worker_check_changed",
          "向导状态已改变，请重新读取。",
        );
      if (s.phase === "running") throw stale();
      if (action === "cancel") {
        audit("cancelled", s);
        this.drop(id);
        return sendJson(res, 200, { cancelled: true });
      }
      const assertPassed = (tx: ReadRepositories) => {
        if (s.phase !== "passed" || !s.check_id) throw stale();
        const latest = this.checks.latest(s.machine, s.project, "worker");
        if (
          latest?.id !== s.check_id ||
          latest.status !== "passed" ||
          !isRegistered(this.store, tx, s.draft)
        )
          throw stale();
      };
      if (action === "launch-preview") {
        this.store.uow.read(assertPassed);
        s.preview = preview(
          planWorkerFile(
            host.root,
            host.dataDir,
            s.draft.raw,
            s.draft.config,
            true,
          ),
          now,
        );
        this.save(s);
        audit("launch_previewed", s);
      } else if (action === "confirm" || action === "enable") {
        const p = s.preview;
        if (!p || p.expires <= now || p.id !== body.preview_id) throw stale();
        if (action === "enable") {
          if (body.allow_remote_launch !== true) throw invalid();
        } else if (s.phase !== "preview") throw stale();
        audit(`${action}_requested`, s);
        try {
          commitWorkerFile(host.root, p.plan, (apply) =>
            this.store.uow.run((tx) => {
              authorize(tx);
              if (action === "enable") assertPassed(tx);
              else checkRegistryCompatibility(this.store, tx, s.draft);
              apply();
              if (action === "enable" && s.origin === "machine")
                this.online(tx, s);
              machineAudit(
                tx,
                this.clock,
                action === "enable"
                  ? "worker_wizard_launch_enabled"
                  : "worker_wizard_config_written",
                {
                  member_id: member,
                  project_id: project,
                  machine_id: s.machine,
                  wizard_id: s.id,
                },
              );
            }),
          );
        } catch (e) {
          audit(`${action}_failed`, s);
          throw e;
        }
        delete s.preview;
        s.phase = action === "enable" ? "enabled" : "ready";
        this.save(s);
      } else if (action === "run") {
        this.startCheck(s, authorize);
        return sendJson(res, 202, { wizard: this.view(s) });
      }
      return sendJson(res, 200, { wizard: this.view(s) });
    } catch (e) {
      throw rejection(e);
    }
  }
}
function rejection(e: unknown) {
  if (e instanceof HttpRejection) return e;
  const code = safeError(e);
  return new HttpRejection(
    code === "worker_form_invalid" || code === "worker_config_invalid"
      ? 400
      : 409,
    code,
    code === "worker_shared_yaml"
      ? "派发开关使用 YAML 锚点，请在主机上核对并拆分共享字段后重新预览。"
      : "请核对向导配置、文件权限和当前预览。",
  );
}
