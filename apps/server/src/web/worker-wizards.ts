import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { activeOwner, type Clock } from "@cardigan/domain";
import {
  commitWorkerFile,
  effectiveRunLimit,
  explicitMcpUrl,
  loadRuntimeWorkers,
  type MachineCheckJournal,
  planWorkerFile,
  type WizardFilePlan,
  WorkerOnboardingError,
  workerMcpConfig,
  workerWizardForm,
} from "@cardigan/host";
import type { ReadRepositories, Store, WebSession } from "@cardigan/store";
import { type DevicePairings, pairingForm } from "./device-pairings.js";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";
import { machineAudit } from "./machine-checks.js";
import type { WizardHost } from "./machine-host.js";
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
}
const stale = () =>
  new HttpRejection(
    409,
    "worker_preview_stale",
    "预览已过期或状态已改变，请重新核对。",
  );
const missing = () => new HttpRejection(404, "not_found", "没有此向导会话");
const invalid = () =>
  new HttpRejection(400, "validation_failed", "向导参数无效");
const safeError = (e: unknown) =>
  e instanceof WorkerOnboardingError ? e.code : "worker_operation_failed";
const preview = (plan: WizardFilePlan, now: number) => ({
  id: randomUUID(),
  expires: now + 15 * 60_000,
  plan,
});
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
function view(s: Session) {
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
    command_guide:
      s.draft.config.worker.os === "darwin"
        ? "docs/macos-worker.md"
        : "docs/linux-worker.md",
    command_prerequisites:
      "仅在目标机管理员终端执行。新建账号前核对名称和数字身份均空闲；按操作手册准备受保护的安装包、目录、认领标记和本机安装配置，Mac 先安装并核验签名 App。已有冲突请停下核对。",
    check_id: s.check_id,
    error: s.error,
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
  ) {}
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
    for (const [key, s] of this.sessions)
      if (s.expires <= now && s.phase !== "running") this.sessions.delete(key);
    const audit = (type: string, s: Session) =>
      this.store.uow.run((tx) =>
        machineAudit(tx, this.clock, `worker_wizard_${type}`, {
          member_id: member,
          project_id: project,
          machine_id: s.machine,
          wizard_id: s.id,
        }),
      );
    // The same draft, checks and preview as a form typed into the wizard.
    const create = (form: Record<string, unknown>) => {
      const draft = workerWizardForm(host.root, host.dataDir, project, form),
        machine = draft.config.worker.machine_id;
      this.store.uow.read((tx) =>
        checkRegistryCompatibility(this.store, tx, draft),
      );
      const plan = planWorkerFile(
        host.root,
        host.dataDir,
        draft.raw,
        draft.config,
      );
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
          this.sessions.delete(s.id);
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
        phase: "preview",
        steps: initialSteps(),
        preview: preview(plan, now),
      };
      audit("previewed", s);
      this.sessions.set(s.id, s);
      return s;
    };
    try {
      if (pairing) {
        if (!this.pairings || Object.keys(body).some((k) => k !== "code"))
          throw invalid();
        // Look up, create and claim in one synchronous turn: of two
        // submissions of one code only the first gets a draft.
        const found = this.pairings.lookup(body.code, member);
        const form = pairingForm(
          found.device,
          project,
          knownMcpUrl(host, project)?.mcp_url,
        );
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
        this.pairings.claim(found);
        this.store.uow.run((tx) =>
          machineAudit(tx, this.clock, "worker_wizard_pairing_claimed", {
            member_id: member,
            project_id: project,
            machine_id: s.machine,
            wizard_id: s.id,
            pairing_id: found.id,
          }),
        );
        return sendJson(res, 201, { wizard: view(s), device: found.device });
      }
      if (!id) return sendJson(res, 201, { wizard: view(create(body)) });
      const s = this.sessions.get(id);
      if (!s || s.member !== member || s.project !== project) throw missing();
      if (read) return sendJson(res, 200, { wizard: view(s) });
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
        this.sessions.delete(id);
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
      } else if (action === "run") {
        if (!["ready", "failed", "passed"].includes(s.phase)) throw stale();
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
          id,
        });
        s.steps = steps;
        s.check_id = check.id;
        s.phase = "running";
        delete s.preview;
        delete s.error;
        const done = check.done.then(
          (ok) => {
            s.phase = ok ? "passed" : "failed";
          },
          (e) => {
            s.phase = "failed";
            s.error = safeError(e);
          },
        );
        this.pending.add(done);
        void done.then(() => this.pending.delete(done));
        return sendJson(res, 202, { wizard: view(s) });
      }
      return sendJson(res, 200, { wizard: view(s) });
    } catch (e) {
      if (e instanceof HttpRejection) throw e;
      const code = safeError(e);
      throw new HttpRejection(
        code === "worker_form_invalid" || code === "worker_config_invalid"
          ? 400
          : 409,
        code,
        code === "worker_shared_yaml"
          ? "派发开关使用 YAML 锚点，请在主机上核对并拆分共享字段后重新预览。"
          : "请核对向导配置、文件权限和当前预览。",
      );
    }
  }
}
