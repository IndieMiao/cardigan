import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { agentProcessCommand } from "@cardigan/runtime-herdr";
import {
  helpers as helperNames,
  workerHelperDigests,
} from "./worker-helper-release.js";
import {
  type WorkerOnboardingConfig,
  workerOnboardingHelperPaths,
} from "./worker-onboarding-config.js";

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
import grp, hashlib, json, os, pathlib, platform, pwd, re, stat, subprocess, sys, urllib.error, urllib.request
def require(ok):
    if not ok: raise ValueError()
def acl_safe(fd):
    return native['acl_safe'](fd) if platform.system() == 'Darwin' else not any(name.startswith('system.posix_acl_') for name in os.listxattr(fd))
def protected(path, uid, gid, mode, regular=False):
    # Anchor each ancestor with openat; Darwin uses the existing native ACL API.
    p = pathlib.Path(path)
    require(p.is_absolute() and os.path.normpath(str(p)) == str(p))
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    try:
        parts = p.parts[1:]
        for index, part in enumerate(parts):
            s = os.fstat(fd)
            require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022)
            require(acl_safe(fd))
            leaf = index == len(parts) - 1
            child = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                            (0 if leaf and regular else os.O_DIRECTORY), dir_fd=fd)
            os.close(fd); fd = child
        s = os.fstat(fd)
        require(s.st_uid == uid and s.st_gid == gid and stat.S_IMODE(s.st_mode) == mode)
        require((stat.S_ISREG(s.st_mode) and s.st_nlink == 1) if regular else stat.S_ISDIR(s.st_mode))
        require(acl_safe(fd))
    finally:
        os.close(fd)
def main():
    c = json.loads(sys.argv[1]); step = c['step']; root = pathlib.Path(c['root'])
    mac = c.get('os') == 'darwin'
    if mac:
        require(platform.system() == 'Darwin' and platform.machine() == 'arm64')
    if step == 'account':
        a = pwd.getpwuid(os.getuid()); g = grp.getgrgid(os.getgid())
        if not mac: require(platform.system() == 'Linux' and platform.machine() == {'x64':'x86_64','arm64':'aarch64'}[c['arch']])
        if mac: macos_account(c)
        require(a.pw_name == c['user'] and a.pw_uid == c['uid'] and a.pw_uid > 0 and a.pw_gid == c['gid'] == os.getgid() and a.pw_dir == c['home'])
        require(os.geteuid() == c['uid'] and os.getegid() == c['gid'])
        groups = native['process_groups']() if mac else os.getgroups()
        if mac: native['isolation_groups'](a, groups, int(c['timeout'] * 1000))
        else: require(set(groups) <= {c['gid']} and set(os.getgrouplist(a.pw_name, a.pw_gid)) == {c['gid']})
        require(g.gr_name not in ('root','sudo','wheel','admin','docker') and set(g.gr_mem) <= {a.pw_name})
        require(not any(p.pw_name != a.pw_name and (p.pw_uid == a.pw_uid or p.pw_gid == a.pw_gid) for p in pwd.getpwall()))
        # Query policy only; never execute a privileged command or prompt for a password.
        denial = subprocess.run(['/usr/bin/sudo', '-n', '-l'], stdin=subprocess.DEVNULL,
            capture_output=True, timeout=c['timeout'], env=dict(PATH='/usr/bin:/bin', LC_ALL='C', LANGUAGE='C', HOME=c['home']))
        require(denial.returncode == 1 and len(denial.stdout) + len(denial.stderr) <= 4096)
        message = (denial.stdout + denial.stderr).decode().strip()
        user = re.escape(c['user'])
        require(re.fullmatch(r'(?:User ' + user + r' is not allowed to run sudo on [A-Za-z0-9_.-]+[.]|Sorry, user ' + user + r' may not run sudo on [A-Za-z0-9_.-]+[.]|' + user + r' is not in the sudoers file[.](?:  This incident will be reported[.])?)', message))
    elif step == 'directories':
        if mac:
            native['macos_check_directory'](c['home'])
            native['macos_check_directory'](root)
        protected(c['home'], 0, c['gid'], 0o750)
        protected(root, 0, c['gid'], 0o750)
        home = pathlib.Path(c['home'])
        for name in ('.local', '.local/bin', '.ssh'):
            protected(home / name, 0, c['gid'], 0o750)
        protected(home / '.ssh/authorized_keys', 0, c['gid'], 0o640, True)
        for name in ('.config', '.cache', '.local/state', '.local/share'):
            protected(home / name, c['uid'], c['gid'], 0o700)
        for name in ('runs','repos','worktrees','builds'):
            protected(root / name, 0, c['gid'], 0o750)
            protected(root / name / c['project'], c['uid'], c['gid'], 0o700)
        for name in ('cache','generated','evidence','temporary'):
            protected(root / name, c['uid'], c['gid'], 0o700)
        for name in ('git','tests'):
            protected(root / 'locks' / (name + '.lock'), 0, c['gid'], 0o660, True)
    elif step == 'tools':
        if mac: macos_tools(c)
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
        require(len(c['helpers']) == 3)
        for path, digest in c['helpers'].items():
            protected(path, 0, c['gid'], 0o750, True)
            data = pathlib.Path(path).read_bytes()
            require(hashlib.sha256(data).hexdigest() == digest)
            compile(data, path, 'exec')
    elif step == 'resources':
        if mac:
            macos_resources(c)
            return
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

/** Ship controller-owned code inline; never import an unverified worker helper. */
export function workerProbeScript(config: WorkerOnboardingConfig): string {
  if (config.worker.os !== "darwin") return WORKER_PROBE_SCRIPT;
  const source = (name: string) =>
    readFileSync(
      new URL(`../../../deploy/${name}.py`, import.meta.url),
      "utf8",
    );
  return `native = {'__name__': 'worker_native'}\nexec(${JSON.stringify(source("worker-primitives"))}, native)\n${source("worker-onboarding-macos")}\n${WORKER_PROBE_SCRIPT}`;
}

export function workerProbeInput(
  step: WorkerProbe,
  config: WorkerOnboardingConfig,
) {
  const e = config.worker.execution;
  const paths = step === "helpers" ? workerOnboardingHelperPaths(e) : undefined;
  const helpers = paths
    ? Object.fromEntries(
        helperNames.map((name, index) => [
          paths[index],
          workerHelperDigests()[name],
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
    session: config.worker.session,
    arch: config.worker.arch,
    os: config.worker.os,
    path: e.path,
    python: e.fileHelper?.python,
    launchd: config.launchd,
    hc_version: config.hc_version,
    timeout: config.timeout_ms / 1000,
    mcp_url: config.mcp_url,
    helpers,
  };
}

export const probeWorker: WorkerProbeRunner = async (step, config) => {
  try {
    const python =
      config.worker.execution.fileHelper?.python ?? "/usr/bin/python3";
    const args = [
      python,
      "-I",
      "-B",
      "-c",
      workerProbeScript(config),
      JSON.stringify(workerProbeInput(step, config)),
    ];
    const command = await agentProcessCommand(
      config.worker.execution,
      step === "ssh"
        ? ["printf", "worker_probe_ok\\n"]
        : config.worker.os === "darwin"
          ? [
              "/bin/sh",
              "-c",
              '[ "$(/usr/bin/uname -m)" = arm64 ] && { /usr/bin/lipo "$1" -verify_arch arm64 >/dev/null 2>&1 || /usr/bin/lipo "$1" -verify_arch arm64e >/dev/null 2>&1; } || exit 1; exec "$@"',
              "worker-probe",
              ...args,
            ]
          : args,
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
    "在 worker 上按 docs/linux-worker.md 核对专用账号、UID/GID、HOME、架构及 sudo 拒绝证据；查询失败或需要密码时由管理员核对策略。",
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
  if (step === "helpers") {
    const guide = config.worker.os === "darwin" ? "macos" : "linux";
    return `${WORKER_NEXT_ACTION.helpers.replace("linux-worker.md", `${guide}-worker.md`)}\nsudo install -o root -g ${e.gid} -m 0750 /opt/cardigan/deploy/worker-files.py ${e.fileHelper?.path}\nsudo install -o root -g ${e.gid} -m 0750 /opt/cardigan/deploy/worker-git.py ${e.gitHelper?.path}`;
  }
  if (config.worker.os === "darwin") {
    const actions: Record<WorkerProbe, string> = {
      ssh: WORKER_NEXT_ACTION.ssh,
      account:
        "按 docs/macos-worker.md 用 dscl 核对专用非管理员账号、UID/GID、HOME 和 sudo 拒绝；仅支持原生 arm64。",
      directories:
        "由管理员按 docs/macos-worker.md 预置目录和标记，再运行 install-macos-worker.py --check/--apply；不要修改已有账号或目录的归属。",
      tools:
        "worker_macos_app_setup_required：按 docs/macos-worker.md 使用 deploy/hc-version.json 的 macos-aarch64 归档；由人在 Mac 现场安装并验证签名 App、为专用账号确认首次局域网许可。核对 arm64 工具和 /opt/homebrew/bin PATH，不使用 Rosetta。",
      helpers: WORKER_NEXT_ACTION.helpers,
      resources:
        "worker_macos_core_owner_or_capacity_required：按 docs/macos-worker.md 设置 run-capacity.yaml 的机器 limit/max_limit 并重载控制主机；在无活跃任务时停用并归档旧 LaunchDaemon，由 hc 经 SSH 自管核心。macOS 无 cgroup 硬隔离。",
      mcp: `${WORKER_NEXT_ACTION.mcp} Mac 首次局域网许可需在专用账号现场确认；原因码 worker_macos_local_network_required。`,
    };
    return actions[step];
  }
  if (step === "account")
    return `${WORKER_NEXT_ACTION[step]}\n新账号才执行：\nsudo groupadd --gid ${e.gid} ${e.user}\nsudo useradd --uid ${config.uid} --gid ${e.gid} --home-dir ${config.home} --no-create-home --shell /bin/sh ${e.user}`;
  if (step === "resources")
    return WORKER_NEXT_ACTION[step].replace("<UID>", String(config.uid));
  if (step === "tools")
    return `${WORKER_NEXT_ACTION[step]}\n安装 Node 24 后：sudo npm install --global pnpm@11.7.0`;
  return WORKER_NEXT_ACTION[step];
}
