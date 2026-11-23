import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { occupiedRunSlots } from "@cardigan/domain";
import { parseWorkerEnvironment } from "@cardigan/roles";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";
import type {
  MachineHealth,
  MachineReadiness,
  MachineReadinessItem,
  ReadRepositories,
  Store,
  StoreTransactionContext,
} from "@cardigan/store";
import { AGENT_TOOLS_CAPABILITY } from "./agent-tools.js";
import {
  loadReadinessConfig,
  type ReadinessConfig,
} from "./machine-readiness-config.js";
import { helperMismatch, softHelperMismatch } from "./worker-helper-release.js";
import { notifyWorkerMaintenance } from "./worker-maintenance.js";

type Worker = Extract<ExecutionConfig, { mode: "agent-ssh" }>;

/** Fixed probe run as the project's worker account. Only numbers and fixed words leave it. */
export const READINESS_SCRIPT = `
import json, os, pwd, socket, subprocess, sys, time
r = json.loads(sys.argv[1])
account = pwd.getpwuid(os.getuid())
env = dict(r.get('env') or {}, PATH=os.environ.get('PATH', '/usr/bin:/bin'), HOME=account.pw_dir, USER=account.pw_name, LOGNAME=account.pw_name, LC_ALL='C')
out = dict(disk=None, rtt_ms=None, avds={}, simulators={})
try:
    s = os.statvfs(r['root'])
    out['disk'] = dict(free=s.f_bavail * s.f_frsize, total=s.f_blocks * s.f_frsize)
except Exception: pass
m = r.get('mcp')
if m:
    try:
        family, kind, proto, _, address = socket.getaddrinfo(m['host'], m['port'], type=socket.SOCK_STREAM)[0]
        samples = []
        for _ in range(3):
            c = socket.socket(family, kind, proto)
            c.settimeout(5)
            started = time.monotonic()
            try: c.connect(address)
            finally: c.close()
            samples.append((time.monotonic() - started) * 1000)
        out['rtt_ms'] = sorted(samples)[1]
    except Exception: pass
def avd(name):
    user = env.get('ANDROID_USER_HOME') or os.path.join(account.pw_dir, '.android')
    home = env.get('ANDROID_AVD_HOME') or os.path.join(user, 'avd')
    try:
        path = os.path.join(home, name + '.avd')
        with open(os.path.join(home, name + '.ini'), encoding='utf-8', errors='replace') as f:
            for line in f:
                k, _, v = line.partition('=')
                if k.strip() == 'path' and v.strip(): path = v.strip()
        os.listdir(path)
        with open(os.path.join(path, 'config.ini'), 'rb') as f: f.read(1)
        for image in ('userdata-qemu.img', 'userdata.img', 'encryptionkey.img'):
            p = os.path.join(path, image)
            if os.path.exists(p):
                with open(p, 'rb') as f: f.read(1)
                break
        return 'ok'
    except FileNotFoundError: return 'missing'
    except OSError: return 'unreadable'
for name in r.get('avds', []): out['avds'][name] = avd(name)
sims = r.get('simulators', [])
if sims:
    names = None
    try:
        p = subprocess.run(['xcrun', 'simctl', 'list', 'devices', 'available', '-j'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=30)
        if p.returncode == 0:
            data = json.loads(p.stdout)
            names = {d.get('name') for devices in data.get('devices', {}).values() for d in devices if d.get('isAvailable') is True}
    except Exception: pass
    for name in sims: out['simulators'][name] = 'unavailable' if names is None else ('ok' if name in names else 'missing')
print(json.dumps(out))
`;

/** Times the controller-to-worker download after the worker is ready to read. */
export const THROUGHPUT_SCRIPT = `
import json, os, sys, time
n = json.loads(sys.argv[1])['bytes']
sys.stdout.write('ready\\n')
sys.stdout.flush()
fd = sys.stdin.fileno()
got, first, head = 0, None, 0
while got < n:
    b = os.read(fd, 65536)
    if not b: break
    t = time.monotonic()
    if first is None: first, head = t, len(b)
    got += len(b)
end = time.monotonic()
print(json.dumps(dict(bytes=got - head, seconds=end - first if first else 0, complete=got >= n)))
`;

/** Deletes only directories owned by this account that are not symlinks. */
export const CLEANUP_SCRIPT = `
import json, os, pwd, re, shutil, stat, sys
r = json.loads(sys.argv[1])
uid = os.getuid()
root = r['root']
if not os.path.isabs(root) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9._-]*', r['project']): raise SystemExit(2)
CACHES = dict(
    darwin=[('Library/Developer/Xcode/DerivedData', True), ('Library/Caches/pip', False), ('Library/Caches/uv', False), ('.cache/uv', False), ('.cache/pip', False), ('.npm/_cacache', False)],
    linux=[('.cache/pip', False), ('.cache/uv', False), ('.npm/_cacache', False)],
)
def free():
    s = os.statvfs(root)
    return s.f_bavail * s.f_frsize
before, removed, failed = free(), 0, 0
def owned(path):
    try: st = os.lstat(path)
    except FileNotFoundError: return None
    return stat.S_ISDIR(st.st_mode) and st.st_uid == uid
def writable(path):
    for d, _, _ in os.walk(path):
        try: os.chmod(d, stat.S_IMODE(os.lstat(d).st_mode) | 0o700)
        except OSError: pass
def clear(path, keep):
    global removed, failed
    state = owned(path)
    if state is None: return
    if not state:
        failed += 1
        return
    try:
        writable(path)
        if keep:
            for entry in os.scandir(path):
                if entry.is_dir(follow_symlinks=False): shutil.rmtree(entry.path)
                else: os.unlink(entry.path)
        else: shutil.rmtree(path)
        removed += 1
    except OSError: failed += 1
runs = os.path.join(root, 'runs', r['project'])
for a in r['assignments']:
    if not re.fullmatch(r'A-[1-9][0-9]*', a) or not owned(os.path.join(runs, a)): continue
    for kind in ('cache', 'generations', 'temporary'): clear(os.path.join(runs, a, kind), False)
if r['account_caches']:
    home = pwd.getpwuid(uid).pw_dir
    for rel, keep in CACHES.get(sys.platform, []): clear(os.path.join(home, rel), keep)
print(json.dumps(dict(before=before, after=free(), removed=removed, failed=failed)))
`;

export type ReadinessScript = "readiness" | "throughput" | "cleanup";
const SCRIPTS: Record<ReadinessScript, string> = {
  readiness: READINESS_SCRIPT,
  throughput: THROUGHPUT_SCRIPT,
  cleanup: CLEANUP_SCRIPT,
};
export type ReadinessRunner = (
  execution: Worker,
  script: ReadinessScript,
  request: Record<string, unknown>,
  options: { payload?: number; timeoutMs: number; signal?: AbortSignal },
) => Promise<unknown>;

/** Bounded worker command; resolves with the final JSON line or rejects. */
export const runReadinessScript: ReadinessRunner = async (
  execution,
  script,
  request,
  options,
) =>
  runScriptProcess(
    await agentProcessCommand(execution, [
      execution.fileHelper?.python ?? "python3",
      "-I",
      "-B",
      "-c",
      SCRIPTS[script],
      JSON.stringify(request),
    ]),
    options,
  );

/** With a payload, the worker announces it is reading before the timed bytes are sent. */
export function runScriptProcess(
  command: { file: string; args: readonly string[] },
  {
    payload,
    timeoutMs,
    signal,
  }: { payload?: number; timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "ignore"],
      ...(signal ? { signal } : {}),
    });
    let output = "",
      sent = false,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdin.on("error", () => undefined);
    if (!payload) child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 65536) child.kill("SIGKILL");
      if (payload && !sent && output.startsWith("ready\n")) {
        sent = true;
        child.stdin.end(randomBytes(payload));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("readiness_timeout"));
      try {
        if (code !== 0) throw new Error("readiness_failed");
        resolve(JSON.parse(output.trim().split("\n").at(-1) ?? ""));
      } catch (error) {
        reject(error);
      }
    });
  });
}

const GIB = 1024 ** 3;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;
const mbps = (rate: number) => `${(rate / 1e6).toFixed(1)} MB/s`;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
/** Released this long ago with nothing pending: its launch files and caches are spare. */
export const RELEASED_GRACE_MS = 24 * 60 * 60 * 1000;

export function releasedAssignments(
  tx: ReadRepositories,
  project: string,
  machine: string,
  now: number,
) {
  const runs = tx.runs.list(project);
  const live = new Set(
    runs
      .filter((r) => !["completed", "failed", "cancelled"].includes(r.status))
      .map((r) => r.assignment_id as string),
  );
  const open = tx.human_actions
    .list(project)
    .filter((h) => h.status === "open");
  const hosts = new Set(open.map((h) => h.host_assignment_id));
  const protectedWork = new Set<string>(
    open.flatMap((h) => [
      ...h.blocked_work_items,
      ...(h.follow_up_work_items ?? []),
    ]),
  );
  return tx.assignments
    .list(project)
    .filter(
      (a) =>
        a.machine_id === machine &&
        a.status === "released" &&
        /^A-[1-9][0-9]*$/u.test(a.id) &&
        Date.parse(a.released_at ?? "") < now - RELEASED_GRACE_MS &&
        !live.has(a.id) &&
        !hosts.has(a.id) &&
        !(a.work_item_id && protectedWork.has(a.work_item_id)),
    )
    .map((a) => a.id as string);
}

function mcpEndpoint(execution: Worker) {
  try {
    const url = new URL(execution.mcp?.url ?? "");
    return url.protocol === "https:"
      ? { host: url.hostname, port: Number(url.port || 443) }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface ReadinessInput {
  readonly store: Store;
  readonly project: string;
  readonly machine: string;
  readonly os: string;
  readonly execution: Worker;
  /** The machine check this patrol just recorded. */
  readonly health: Pick<
    MachineHealth,
    "blockers" | "warnings" | "capability_failures"
  >;
  readonly capabilities: readonly string[];
  readonly now: () => string;
  readonly signal?: AbortSignal | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly config?: () => { config: ReadinessConfig; invalid: boolean };
  readonly run?: ReadinessRunner;
}
export interface ReadinessOutcome {
  readonly readiness: MachineReadiness;
  readonly repaired?: {
    readonly freed_bytes: number;
    readonly removed: number;
  };
}

/** Blockers for which the worker cannot even run the readiness probe. */
export function readinessReachable(blockers: readonly string[]) {
  return blockers.every(
    (b) =>
      b.startsWith("mcp_") ||
      helperMismatch(b) ||
      [
        "worker_helpers",
        "worker_directories",
        "hc_version",
        "machine_not_ready",
        "worker_helper_upgrade_unverified",
      ].includes(b),
  );
}

/** Never throws and never adds a blocker: every finding is a warning except an unreachable MCP. */
export async function observeReadiness(
  input: ReadinessInput,
): Promise<ReadinessOutcome> {
  const { store, project, machine, execution, health } = input;
  const run = input.run ?? runReadinessScript;
  const { config, invalid } = (
    input.config ?? (() => loadReadinessConfig(input.env))
  )();
  const declared = config.projects[project];
  const remote = machine !== "local";
  const endpoint = remote ? mcpEndpoint(execution) : undefined;
  const env = (() => {
    try {
      return execution.env ? parseWorkerEnvironment(execution.env) : {};
    } catch {
      return {};
    }
  })();
  const items: MachineReadinessItem[] = [];
  const metrics: Record<string, number> = {};
  let repaired: ReadinessOutcome["repaired"];
  const probe = async <T>(
    script: ReadinessScript,
    request: Record<string, unknown>,
    timeoutMs: number,
    payload?: number,
  ): Promise<T | undefined> => {
    try {
      input.signal?.throwIfAborted();
      return (await run(execution, script, request, {
        timeoutMs,
        ...(payload ? { payload } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })) as T;
    } catch {
      return undefined;
    }
  };
  const avds = declared?.android_avds ?? [];
  const simulators =
    input.os === "darwin" ? (declared?.ios_simulators ?? []) : [];
  const observed = await probe<{
    disk?: { free?: unknown; total?: unknown } | null;
    rtt_ms?: unknown;
    avds?: Record<string, unknown>;
    simulators?: Record<string, unknown>;
  }>(
    "readiness",
    {
      root: execution.agentRoot,
      env,
      ...(endpoint ? { mcp: endpoint } : {}),
      avds,
      simulators,
    },
    60_000,
  );

  // Disk: clean what is known to be spare, alert only if it is still short.
  const free = observed?.disk?.free;
  if (!finite(free))
    items.push({ key: "disk", status: "unknown", detail: "磁盘空间未能读取" });
  else if (free >= config.disk_min_free_bytes) {
    metrics.disk_free_bytes = free;
    items.push({ key: "disk", status: "ok", detail: `可用 ${gib(free)}` });
  } else {
    const plan = store.uow.read((tx) => ({
      assignments: releasedAssignments(
        tx,
        project,
        machine,
        Date.parse(input.now()),
      ),
      // Account caches may belong to a build in flight; only clear them while idle.
      idle:
        occupiedRunSlots(
          tx.assignments.list(project),
          tx.runs.list(project),
          machine,
        ) === 0,
    }));
    const cleaned = await probe<{
      before?: unknown;
      after?: unknown;
      removed?: unknown;
    }>(
      "cleanup",
      {
        root: execution.agentRoot,
        project,
        assignments: plan.assignments,
        account_caches: plan.idle,
      },
      300_000,
    );
    const after = finite(cleaned?.after) ? cleaned.after : free;
    const freed = Math.max(0, after - free);
    const removed = finite(cleaned?.removed) ? cleaned.removed : 0;
    metrics.disk_free_bytes = after;
    if (freed > 0 || removed > 0) repaired = { freed_bytes: freed, removed };
    const note = cleaned
      ? `已自动清理 ${removed} 处缓存，释放 ${gib(freed)}${plan.idle ? "" : "（有任务在跑，账号级缓存留到空闲时清）"}`
      : "自动清理未能执行";
    items.push(
      after >= config.disk_min_free_bytes
        ? {
            key: "disk",
            status: "repaired",
            detail: `${note}，可用 ${gib(after)}`,
          }
        : {
            key: "disk",
            status: "warning",
            detail: `可用 ${gib(after)}，低于 ${gib(config.disk_min_free_bytes)}；${note}`,
          },
    );
  }

  // Network: a slow link is reported as such, not only as an MCP timeout.
  let slow: string | undefined;
  if (remote) {
    const rtt = observed?.rtt_ms;
    const measured =
      config.payload_bytes > 0
        ? await probe<{
            bytes?: unknown;
            seconds?: unknown;
            complete?: unknown;
          }>(
            "throughput",
            { bytes: config.payload_bytes },
            30_000,
            config.payload_bytes,
          )
        : undefined;
    const rate =
      measured &&
      measured.complete === true &&
      finite(measured.bytes) &&
      finite(measured.seconds)
        ? measured.seconds > 0
          ? measured.bytes / measured.seconds
          : Number.POSITIVE_INFINITY
        : undefined;
    if (finite(rtt)) metrics.rtt_ms = Math.round(rtt);
    if (rate !== undefined && Number.isFinite(rate))
      metrics.throughput_bytes_per_s = Math.round(rate);
    const parts = [
      rate === undefined
        ? config.payload_bytes > 0
          ? "下行测速未完成"
          : undefined
        : Number.isFinite(rate)
          ? `下行 ${mbps(rate)}`
          : undefined,
      finite(rtt) ? `往返 ${Math.round(rtt)} ms` : "往返未测到",
    ].filter(Boolean);
    const tooSlow =
      (finite(rtt) && rtt > config.max_rtt_ms) ||
      (config.payload_bytes > 0 &&
        (rate === undefined || rate < config.min_throughput_bytes_per_s));
    if (!observed && !measured)
      items.push({ key: "network", status: "unknown", detail: "链路未能测量" });
    else if (tooSlow) {
      slow = `链路慢：${parts.join("，")}（阈值 ${mbps(config.min_throughput_bytes_per_s)}、${config.max_rtt_ms} ms）`;
      items.push({ key: "network", status: "warning", detail: slow });
    } else
      items.push({ key: "network", status: "ok", detail: parts.join("，") });
    const mcp = health.blockers.find((b) => b.startsWith("mcp_"));
    items.push(
      mcp
        ? {
            key: "mcp",
            status: "failed",
            detail: `Card MCP 不可达（${mcp}），暂停向该机器派发${slow ? `；${slow}` : ""}`,
          }
        : health.blockers.length
          ? { key: "mcp", status: "unknown", detail: "本次未检查 Card MCP" }
          : { key: "mcp", status: "ok", detail: "Card MCP 可达" },
    );
    const hard = health.blockers.find(
      (b) => helperMismatch(b) || b === "worker_helpers",
    );
    const soft = health.warnings?.find(softHelperMismatch);
    items.push(
      hard
        ? { key: "helper", status: "failed", detail: hard }
        : soft
          ? {
              key: "helper",
              status: "warning",
              detail: `${soft}；协议兼容，继续派发并自动升级`,
            }
          : { key: "helper", status: "ok", detail: "与当前部署一致" },
    );
  }
  const tools = health.capability_failures?.find(
    (f) => f.key === AGENT_TOOLS_CAPABILITY,
  );
  items.push(
    tools
      ? {
          key: "agent_tools",
          status: "warning",
          detail: tools.reason ?? "附件助手检查未通过",
        }
      : input.capabilities.includes(AGENT_TOOLS_CAPABILITY)
        ? { key: "agent_tools", status: "ok", detail: "附件助手就绪" }
        : {
            key: "agent_tools",
            status: "unknown",
            detail: "本次未检查附件助手",
          },
  );
  const avdText = {
    missing: "AVD 不存在",
    unreadable: "AVD 文件无法读取（检查外接盘与系统隐私权限）",
  } as Record<string, string>;
  for (const name of avds) {
    const state = observed?.avds?.[name];
    items.push(
      state === "ok"
        ? { key: `avd:${name}`, status: "ok", detail: "AVD 可读" }
        : typeof state === "string" && avdText[state]
          ? { key: `avd:${name}`, status: "warning", detail: avdText[state] }
          : { key: `avd:${name}`, status: "unknown", detail: "AVD 未能检查" },
    );
  }
  for (const name of simulators) {
    const state = observed?.simulators?.[name];
    items.push(
      state === "ok"
        ? { key: `simulator:${name}`, status: "ok", detail: "模拟器设备可用" }
        : state === "missing"
          ? {
              key: `simulator:${name}`,
              status: "warning",
              detail: "模拟器设备不存在或不可用",
            }
          : {
              key: `simulator:${name}`,
              status: "unknown",
              detail: "模拟器未能检查",
            },
    );
  }
  if (invalid)
    items.push({
      key: "config",
      status: "warning",
      detail: "就绪巡检配置无效，已按默认值检查",
    });
  return {
    readiness: {
      checked_at: input.now(),
      items,
      ...(Object.keys(metrics).length ? { metrics } : {}),
    },
    ...(repaired ? { repaired } : {}),
  };
}

// Helper drift and attachment tools already have their own upgrade tasks (C-548/C-599).
const alerting = (item: MachineReadinessItem) =>
  item.key !== "helper" &&
  item.key !== "agent_tools" &&
  (item.status === "warning" || item.status === "failed");

/**
 * Timeline and host ops follow-up in the observation's own transaction. Only a
 * new or changed problem alerts; an unchanged one is not repeated.
 */
export function recordReadiness(
  tx: StoreTransactionContext,
  project: string,
  machine: string,
  previous: MachineReadiness | undefined,
  outcome: ReadinessOutcome,
  now: string,
) {
  const before = new Map(previous?.items.map((i) => [i.key, i]) ?? []);
  const items = outcome.readiness.items;
  const changed =
    !previous ||
    items.length !== previous.items.length ||
    items.some((i) => before.get(i.key)?.status !== i.status);
  const event = (type: string, payload: Record<string, unknown>) =>
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type,
      actor: { kind: "system", project_id: project },
      created_at: now,
      payload: { machine_id: machine, ...payload },
    });
  if (outcome.repaired)
    event("machine_readiness_repaired", { key: "disk", ...outcome.repaired });
  if (changed)
    event("machine_readiness_changed", {
      items: items.map(({ key, status, detail }) => ({ key, status, detail })),
    });
  for (const item of items) {
    if (!alerting(item)) continue;
    const old = before.get(item.key);
    if (old && old.status === item.status) continue;
    notifyWorkerMaintenance(
      tx,
      project,
      { now: () => now },
      `worker-readiness:${machine}:${item.key}`,
      `项目 ${project} 的机器 ${machine} 就绪巡检：${item.detail}。${item.status === "failed" ? "" : "系统已继续派发能做的任务，"}处理后等待下次巡检确认。`,
    );
  }
}
