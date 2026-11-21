import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ActionCommand } from "@cardigan/domain";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";

type Worker = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
const release = new URL("../../../deploy/", import.meta.url);
const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
let archive: Buffer | undefined;
function releaseArchive() {
  // Only the running controller's release, never project worktrees or SSH-supplied paths.
  // Pin the exact release bytes across patrols, independent of build/archive timestamps.
  archive ??= execFileSync(
    "/usr/bin/tar",
    [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--exclude=__pycache__",
      "-czf",
      "-",
      "-C",
      fileURLToPath(new URL("../", release)),
      "deploy",
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return archive;
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function upgradeMaterials(worker: Worker, os: string) {
  const { target, fileHelper, gitHelper } = worker;
  if (
    !target ||
    target.machine_id === "local" ||
    !fileHelper ||
    !gitHelper ||
    !["linux", "darwin"].includes(os)
  )
    throw new Error("worker_binding_unavailable");
  const bundle = releaseArchive();
  const binding = Buffer.from(
    JSON.stringify({
      project: target.project_id,
      account: worker.user,
      root: worker.agentRoot,
      gid: worker.gid,
      os,
      files: fileHelper.path,
      git: gitHelper.path,
    }),
  ).toString("base64");
  const script = Buffer.concat([
    readFileSync(new URL("upgrade-worker-helpers.py", release)),
    Buffer.from(`\nupgrade('${binding}')\n`),
  ]);
  const digests = [sha(bundle), sha(script)];
  const dir = `/tmp/cardigan-upgrade-${sha(JSON.stringify([digests, target.fingerprint])).slice(0, 32)}`;
  const mac = os === "darwin";
  // Use a fresh root-only destination and fixed bytes, never a manifest or executable in /tmp.
  const shell = [
    "set -eu",
    "export PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    "umask 077",
    `work=$(mktemp -d ${mac ? "/private/var/root" : "/root"}/cardigan-upgrade.XXXXXXXX)`,
    `cd "$work"`,
    ...[
      ["deploy.tar.gz", bundle.length],
      ["upgrade.py", script.length],
    ].map(
      ([name, size]) =>
        `test -f ${dir}/${name} && test ! -L ${dir}/${name} || exit 1; /usr/bin/head -c ${Number(size) + 1} ${dir}/${name} > ${name}`,
    ),
    `printf '%s\\n' '${digests[0]}  deploy.tar.gz' '${digests[1]}  upgrade.py' | ${mac ? "/usr/bin/shasum -a 256" : "/usr/bin/sha256sum"} -c -`,
    "/usr/bin/python3 -IB upgrade.py",
  ].join("; ");
  const terminal: ActionCommand = {
    target: target.machine_id,
    login: "用管理员账号登录目标机器，在该机终端执行（需要 sudo）。",
    command: `/usr/bin/sudo /bin/sh -c ${quote(shell)}`,
    expected_output:
      "两项摘要均为 OK，最后输出 worker_helper_upgrade_ok 和备份位置。",
    on_failure:
      "停止操作，不跳过摘要检查，不恢复派发。记录失败项和备份位置交主机运维核对；临时文件丢失时等待巡检重新备料。",
  };
  return { bundle, script, dir, terminal, python: fileHelper.python };
}
// Executed as the existing unprivileged worker account. No helper upgrade protocol or sudo.
const receive = `import base64,json,os,stat,sys,tempfile
p=sys.argv[1]
try: os.mkdir(p,0o700)
except FileExistsError: pass
fd=os.open(p,os.O_DIRECTORY|os.O_NOFOLLOW)
s=os.fstat(fd)
if os.geteuid()==0 or s.st_uid!=os.geteuid() or stat.S_IMODE(s.st_mode)!=0o700: raise ValueError()
os.fchdir(fd)
for name,data in zip(('deploy.tar.gz','upgrade.py'),json.load(sys.stdin)):
    with tempfile.NamedTemporaryFile(dir='.',delete=False) as f: f.write(base64.b64decode(data,validate=True))
    os.replace(f.name,name)
print('staged')`;
export async function stageWorkerUpgrade(
  worker: Worker,
  os: string,
  signal?: AbortSignal,
) {
  const { dir, bundle, script, terminal, python } = upgradeMaterials(
    worker,
    os,
  );
  const cmd = await agentProcessCommand(worker, [
    python,
    "-IB",
    "-c",
    receive,
    dir,
  ]);
  await new Promise<void>((resolve, reject) => {
    const rejectStage = () =>
      reject(new Error("worker_release_staging_failed"));
    const child = execFile(
      cmd.file,
      cmd.args,
      {
        timeout: worker.publication?.timeout_ms ?? 30000,
        signal,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
      },
      (err, out) =>
        err || out.trim() !== "staged" ? rejectStage() : resolve(),
    );
    child.stdin?.on("error", rejectStage);
    child.stdin?.end(
      JSON.stringify([bundle, script].map((b) => b.toString("base64"))),
    );
  });
  return terminal;
}
