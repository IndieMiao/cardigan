import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { agentProcessCommand } from "@cardigan/runtime-herdr";
import type { WorkerOnboardingConfig } from "./worker-onboarding-config.js";

export const WORKER_PROBES = [
  "ssh",
  "account",
  "directories",
  "tools",
  "helpers",
  "resources",
  "mcp",
] as const;
export type WorkerProbe = (typeof WORKER_PROBES)[number];
export type WorkerProbeRunner = (
  step: WorkerProbe,
  config: WorkerOnboardingConfig,
) => Promise<boolean>;

// Fixed read-only program. Request contains configuration references, never credentials.
// Errors, subprocess output and HTTP response bodies never leave this process.
export const WORKER_PROBE_SCRIPT = `
import grp, hashlib, json, os, pathlib, platform, pwd, stat, subprocess, sys, urllib.error, urllib.request
def require(ok):
    if not ok: raise ValueError()
def protected(path, uid, gid, mode, regular=False):
    p = pathlib.Path(path)
    for parent in [p, *p.parents]:
        s = parent.lstat()
        require(not stat.S_ISLNK(s.st_mode))
        if parent != p: require(s.st_uid == 0 and not s.st_mode & 0o022)
    s = p.lstat()
    require(s.st_uid == uid and s.st_gid == gid and stat.S_IMODE(s.st_mode) == mode)
    require((stat.S_ISREG(s.st_mode) and s.st_nlink == 1) if regular else stat.S_ISDIR(s.st_mode))
def main():
    c = json.loads(sys.argv[1]); step = c['step']; root = pathlib.Path(c['root'])
    if step == 'account':
        a = pwd.getpwuid(os.getuid()); g = grp.getgrgid(os.getgid())
        require(platform.system() == 'Linux' and platform.machine() == {'x64':'x86_64','arm64':'aarch64'}[c['arch']])
        require(a.pw_name == c['user'] and a.pw_uid == c['uid'] and a.pw_uid > 0 and a.pw_gid == c['gid'] == os.getgid() and a.pw_dir == c['home'])
        require(set(os.getgroups()) <= {c['gid']} and set(os.getgrouplist(a.pw_name, a.pw_gid)) == {c['gid']})
        require(g.gr_name not in ('root','sudo','wheel','admin','docker') and set(g.gr_mem) <= {a.pw_name})
        require(not any(p.pw_name != a.pw_name and (p.pw_uid == a.pw_uid or p.pw_gid == a.pw_gid) for p in pwd.getpwall()))
    elif step == 'directories':
        protected(c['home'], 0, c['gid'], 0o750)
        protected(root, 0, c['gid'], 0o750)
        for name in ('runs','repos','worktrees','builds'):
            protected(root / name, 0, c['gid'], 0o750)
            protected(root / name / c['project'], c['uid'], c['gid'], 0o700)
        for name in ('cache','generated','evidence','temporary'):
            protected(root / name, c['uid'], c['gid'], 0o700)
        for name in ('git','tests'):
            protected(root / 'locks' / (name + '.lock'), 0, c['gid'], 0o660, True)
    elif step == 'tools':
        env = dict(PATH=os.environ['PATH'], HOME=c['home'], LC_ALL='C')
        def version(command):
            r = subprocess.run(command, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=c['timeout'])
            require(r.returncode == 0 and len(r.stdout) < 4096)
            return r.stdout.decode().strip()
        require(version(['hc','--version']) == 'hc ' + c['hc_version'])
        require(version(['git','--version']).startswith('git version '))
        require(int(version(['node','--version']).lstrip('v').split('.')[0]) >= 24)
        require(version(['pnpm','--version']).split('.')[0] == '11')
    elif step == 'helpers':
        for path, digest in c['helpers'].items():
            protected(path, 0, c['gid'], 0o750, True)
            data = pathlib.Path(path).read_bytes()
            require(hashlib.sha256(data).hexdigest() == digest)
            compile(data, path, 'exec')
    elif step == 'resources':
        base = pathlib.Path('/sys/fs/cgroup')
        require((base / 'cgroup.controllers').is_file())
        lines = pathlib.Path('/proc/self/cgroup').read_text().splitlines()
        relative = next(line[3:] for line in lines if line.startswith('0::'))
        require('..' not in pathlib.PurePosixPath(relative).parts)
        current = base / relative.lstrip('/')
        limits = set()
        while current != base:
            for name in ('cpu.max', 'memory.max', 'pids.max'):
                path = current / name
                if path.is_file():
                    first = path.read_text().split()[0]
                    if first.isdigit() and int(first) > 0: limits.add(name)
            current = current.parent
        require(limits == {'cpu.max', 'memory.max', 'pids.max'})
    elif step == 'mcp':
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs): return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(c['mcp_url'], data=b'{}', headers={'Content-Type':'application/json'}, method='POST')
        try:
            with opener.open(request, timeout=c['timeout']): pass
            require(False)
        except urllib.error.HTTPError as e:
            require(e.code == 401)
    else: require(False)
try:
    main()
    print('worker_probe_ok')
except Exception:
    sys.exit(1)
`;

export function workerProbeInput(
  step: WorkerProbe,
  config: WorkerOnboardingConfig,
) {
  const e = config.worker.execution;
  const helpers =
    step === "helpers"
      ? Object.fromEntries(
          [
            [e.fileHelper?.path, "worker-files.py"],
            [e.gitHelper?.path, "worker-git.py"],
            [
              `${e.agentRoot}/libexec/worker-primitives.py`,
              "worker-primitives.py",
            ],
          ].map(([path, source]) => [
            path,
            createHash("sha256")
              .update(
                readFileSync(
                  new URL(`../../../deploy/${source}`, import.meta.url),
                ),
              )
              .digest("hex"),
          ]),
        )
      : {};
  return {
    step,
    root: e.agentRoot,
    user: e.user,
    uid: config.uid,
    gid: e.gid,
    home: config.home,
    project: config.worker.project_id,
    arch: config.worker.arch,
    hc_version: config.hc_version,
    timeout: config.timeout_ms / 1000,
    mcp_url: config.mcp_url,
    helpers,
  };
}

export const probeWorker: WorkerProbeRunner = async (step, config) => {
  try {
    const command = await agentProcessCommand(
      config.worker.execution,
      step === "ssh"
        ? ["printf", "worker_probe_ok\\n"]
        : [
            config.worker.execution.fileHelper?.python ?? "/usr/bin/python3",
            "-I",
            "-B",
            "-c",
            WORKER_PROBE_SCRIPT,
            JSON.stringify(workerProbeInput(step, config)),
          ],
    );
    return await new Promise<boolean>((resolve) => {
      const child = spawn(command.file, command.args, {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: config.timeout_ms,
        killSignal: "SIGKILL",
      });
      let output = "";
      let overflow = false;
      child.stdout.on("data", (data: Buffer) => {
        if (output.length + data.length > 4096) {
          overflow = true;
          child.kill("SIGKILL");
        } else output += data.toString("utf8");
      });
      child.once("error", () => resolve(false));
      child.once("close", (code) =>
        resolve(!overflow && code === 0 && output === "worker_probe_ok\n"),
      );
    });
  } catch {
    return false;
  }
};

export const WORKER_NEXT_ACTION: Record<WorkerProbe, string> = {
  ssh: "在控制主机核对专用私钥和已从可信渠道确认的 Ed25519 host key；不要关闭 StrictHostKeyChecking。",
  account:
    "在 worker 上按 docs/linux-worker.md 创建专用非管理员账号，核对 UID、GID、HOME 和架构。",
  directories:
    "在 worker 上执行：sudo python3 /opt/cardigan/deploy/install-linux-worker.py --config /etc/cardigan/worker.json --apply",
  tools:
    "在 worker 上按 docs/linux-worker.md 安装固定版本 hc、Node、pnpm、Git 和 Python。",
  helpers:
    "在 worker 上按 docs/linux-worker.md 安装当前版本的 worker-git.py、worker-files.py、worker-primitives.py。",
  resources:
    "在 worker 上执行：sudo systemctl edit user-<UID>.slice；按 docs/linux-worker.md 配置 CPUQuota、MemoryMax、TasksMax 后重新登录。",
  mcp: "核对 tailnet 连接、HTTPS 证书与 Tailscale Serve 的 /mcp 转发；无 Token 请求应返回 401。",
};

/** Copyable operator commands contain only validated non-secret identity fields. */
export function workerNextAction(
  step: WorkerProbe,
  config: WorkerOnboardingConfig,
): string {
  const e = config.worker.execution;
  if (step === "account")
    return `${WORKER_NEXT_ACTION[step]}\n新账号才执行：\nsudo groupadd --gid ${e.gid} ${e.user}\nsudo useradd --uid ${config.uid} --gid ${e.gid} --home-dir ${config.home} --no-create-home --shell /bin/sh ${e.user}`;
  if (step === "resources")
    return WORKER_NEXT_ACTION[step].replace("<UID>", String(config.uid));
  if (step === "helpers")
    return `${WORKER_NEXT_ACTION[step]}\nsudo install -o root -g ${e.gid} -m 0750 /opt/cardigan/deploy/worker-files.py ${e.fileHelper?.path}\nsudo install -o root -g ${e.gid} -m 0750 /opt/cardigan/deploy/worker-git.py ${e.gitHelper?.path}`;
  if (step === "tools")
    return `${WORKER_NEXT_ACTION[step]}\n安装 Node 24 后：sudo npm install --global pnpm@11.7.0`;
  return WORKER_NEXT_ACTION[step];
}
