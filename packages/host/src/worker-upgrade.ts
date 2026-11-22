import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { ActionCommand } from "@cardigan/domain";
import { gitEnvironment, gitSafetyArguments } from "@cardigan/git-transport";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";

type Worker = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
const release = new URL("../../../deploy/", import.meta.url);
const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
// DeploymentBuild checks out a private clone for each release. Do not include
// untracked files or consult the server cwd / the project being developed.
function readRelease() {
  const root = fileURLToPath(new URL("../", release));
  const git = (...args: string[]) =>
    execFileSync(
      "/usr/bin/git",
      [...gitSafetyArguments, "--git-dir=.git", ...args],
      {
        cwd: root,
        env: gitEnvironment(),
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  const rev = git("rev-parse", "--verify", "HEAD^{commit}").toString().trim();
  if (!/^[0-9a-f]{40}$/u.test(rev)) throw new Error("worker_release_unknown");
  const manifest: Record<string, string> = {};
  for (const line of git("ls-tree", "-rz", rev, "--", "deploy")
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const match =
      /^100(?:644|755) blob ([a-f0-9]{40})\tdeploy\/([a-zA-Z0-9_-][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)*)$/u.exec(
        line,
      );
    if (!match) throw new Error("unsupported_deploy_entry");
    const path = join(root, "deploy", match[2] as string);
    if (!lstatSync(path).isFile()) throw new Error("worker_release_changed");
    const data = readFileSync(path);
    if (
      createHash("sha1")
        .update(`blob ${data.length}\0`)
        .update(data)
        .digest("hex") !== match[1]
    )
      throw new Error("worker_release_changed");
    manifest[match[2] as string] = sha(data);
  }
  const template = readFileSync(new URL("manual-worker-upgrade.py", release));
  if (sha(template) !== manifest["manual-worker-upgrade.py"])
    throw new Error("worker_release_changed");
  const bundle = gzipSync(git("archive", "--format=tar", rev, "deploy"));
  return { manifest, template, bundle, rev, bundleSha: sha(bundle) };
}
let cached: ReturnType<typeof readRelease> | undefined;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// Open the staged directory and regular files without following links; only
// read the two release-sized inputs. Checksums are verified on the private copies.
const copyInputs = `import os,stat,sys
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
for name,size in zip(('deploy.tar.gz','upgrade.py'),map(int,sys.argv[2:])):
    src=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    with os.fdopen(src,'rb') as f:
        s=os.fstat(src)
        if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size!=size: raise ValueError('invalid_stage')
        with open(name,'xb') as out: out.write(f.read(size+1))`;
export function upgradeMaterials(worker: Worker, os: string) {
  const { target, fileHelper, gitHelper } = worker;
  if (
    !target ||
    target.machine_id === "local" ||
    !fileHelper ||
    !gitHelper ||
    !worker.user ||
    fileHelper.path !== `${worker.agentRoot}/libexec/worker-files.py` ||
    gitHelper.path !== `${worker.agentRoot}/libexec/worker-git.py` ||
    !["linux", "darwin"].includes(os)
  )
    throw new Error("worker_binding_unavailable");
  cached ??= readRelease();
  const { bundle, manifest, template, rev, bundleSha } = cached;
  const binding = Buffer.from(
    JSON.stringify({
      project: target.project_id,
      account: worker.user,
      root: worker.agentRoot,
      gid: worker.gid,
      os,
      manifest,
      rev,
      bundleSha,
    }),
  ).toString("base64");
  const script = Buffer.concat([
    template,
    Buffer.from(`\nupgrade('${binding}')\n`),
  ]);
  const digests = [bundleSha, sha(script)];
  const dir = `/tmp/cardigan-upgrade-${sha(JSON.stringify([digests, target.fingerprint])).slice(0, 32)}`;
  const mac = os === "darwin";
  // Use a fresh root-only destination and fixed bytes, never a manifest or executable in /tmp.
  const shell = [
    "set -eu",
    "export PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    "umask 077",
    `work=$(mktemp -d ${mac ? "/private/var/root" : "/root"}/cardigan-upgrade.XXXXXXXX)`,
    `cd "$work"`,
    `/usr/bin/python3 -IB -c ${quote(`exec(${JSON.stringify(copyInputs)})`)} ${dir} ${bundle.length} ${script.length}`,
    `printf '%s\\n' '${digests[0]}  deploy.tar.gz' '${digests[1]}  upgrade.py' | ${mac ? "/usr/bin/shasum -a 256" : "/usr/bin/sha256sum"} -c -`,
    "/usr/bin/python3 -IB upgrade.py",
  ].join("; ");
  const terminal: ActionCommand = {
    target: `${target.machine_id}（项目 ${target.project_id}）`,
    login: "用管理员账号登录目标机器，在该机终端执行（需要 sudo）。",
    command: `/usr/bin/sudo /bin/sh -c ${quote(shell)}`,
    expected_output:
      "两项摘要均为 OK，最后输出“升级完成”；旧 deploy 和 helper 的备份位置见终端。",
    on_failure:
      "停止操作，不跳过摘要检查，不重跑、不恢复派发。记录失败项和备份位置交主机运维核对；临时文件丢失时等待巡检重新备料。",
  };
  return { bundle, script, dir, terminal, python: fileHelper.python };
}
// Executed as the existing unprivileged worker account. No helper upgrade protocol or sudo.
const receive = `import base64,hashlib,json,os,stat,sys,tempfile
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
    with os.fdopen(os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as stored:
        if not stat.S_ISREG(os.fstat(stored.fileno()).st_mode): raise ValueError()
        print(hashlib.sha256(stored.read(len(data)+1)).hexdigest())`;
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
        err || out.trim() !== `${sha(bundle)}\n${sha(script)}`
          ? rejectStage()
          : resolve(),
    );
    child.stdin?.on("error", rejectStage);
    child.stdin?.end(
      JSON.stringify([bundle, script].map((b) => b.toString("base64"))),
    );
  });
  return terminal;
}
