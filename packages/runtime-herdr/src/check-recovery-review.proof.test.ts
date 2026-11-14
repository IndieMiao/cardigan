import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
// Adapted from attachment-1403 after reproducing all three failures at 6ade0d65.
import type { CheckRecoveryBinding } from "./check-recovery.js";
import { CHECK_RECOVERY_WORKER } from "./check-recovery-worker.js";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});
const definitions = CHECK_RECOVERY_WORKER.slice(
  0,
  CHECK_RECOVERY_WORKER.indexOf("\ntry: main()"),
);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "check-recovery-"));
  roots.push(root);
  const repo = join(root, "repos", "p"),
    container = join(root, "checks", "p", "attempt");
  await mkdir(repo, { recursive: true, mode: 0o700 });
  await mkdir(container, { recursive: true, mode: 0o700 });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  git("init", "--bare");
  const tree = execFileSync(
    "git",
    ["-C", repo, "hash-object", "-w", "-t", "tree", "--stdin"],
    { input: "", encoding: "utf8" },
  ).trim();
  const sha = git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit-tree",
    tree,
    "-m",
    "fixture",
  );
  const worktree = join(container, "worktree");
  git("worktree", "add", "--detach", worktree, sha);
  const registry = (await readFile(join(worktree, ".git"), "utf8"))
    .trim()
    .slice("gitdir: ".length);
  const identity = async (path: string) => {
    const s = await lstat(path);
    return { device: String(s.dev), inode: String(s.ino), uid: s.uid };
  };
  const binding: CheckRecoveryBinding = {
    git_layout: "bare",
    registration_name: registry.split("/").at(-1) as string,
    container: await identity(container),
    worktree: await identity(worktree),
    repository: await identity(repo),
    registration: await identity(registry),
  };
  const lock = join(root, "merge-check.lock");
  await writeFile(lock, "", { mode: 0o444 });
  await chmod(lock, 0o444);
  const run = (
    options: {
      before?: string;
      atAuthorize?: string;
      resume?: boolean;
      realProtection?: boolean;
    } = {},
  ) => {
    // Only the administrator-owned namespace is synthetic. Directory descriptors,
    // nofollow, Git registration and flock still use real temporary files.
    const code = `${options.realProtection ? definitions : definitions.replace("info.st_uid == os.getuid() or info.st_nlink", "info.st_uid != os.getuid() or info.st_nlink")}
${options.realProtection ? "" : "protected_root = lambda root: pin(root)"}
root = sys.argv[1]
mounts = lambda: ''
scan = lambda roots, objects: None
${options.before ?? ""}
original_input = sys.stdin
class Input:
    count = 0
    def readline(self, size):
        self.count += 1
        if self.count == 2:
            ${options.atAuthorize ?? "pass"}
        return original_input.readline(size)
sys.stdin = Input()
try: main()
except Occupied as error: output('manual_attention', error.reason, error.processes)
except Exception: output('manual_attention', 'unverified')
`;
    const result = spawnSync("python3", ["-I", "-c", code, root], {
      input: `${JSON.stringify({ project: "p", attempt: "attempt", sha, binding, slots: 1, auth_key: "a".repeat(64), resume: options.resume ?? false })}\ndelete\n`,
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    return {
      ready: lines.some((line) => JSON.parse(line).phase === "ready"),
      ...JSON.parse(lines.at(-1) as string),
    };
  };
  return { root, repo, container, worktree, registry, binding, sha, git, run };
}

test("review proof: a process opening the payload after the final sample must prevent deletion", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "payload"), "held by synthetic PID 71");
  const result = f.run({
    before: `
scans = 0
held = None
def scan(roots, objects):
    global scans, held
    scans += 1
    if held is not None:
        raise Occupied([dict(pid=71, state='S', wchan='fixture_wait')])
    if scans == 1:
        # The fake PID acquires a real fixture descriptor just after the last sample.
        held = os.open(root + '/checks/p/attempt/worktree/payload', os.O_RDONLY)
`,
  });
  expect(result.status).toBe("manual_attention");
  expect(await readFile(join(f.worktree, "payload"), "utf8")).toContain("held");
});

test("review proof: a directory moved after the last path check must retain its payload", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "payload"), "must survive outside attempt");
  const result = f.run({
    before: `
original_same = same
moved = False
def same(path, fd, expected):
    global moved
    value = original_same(path, fd, expected)
    if not moved and path == root + '/checks/p/attempt/worktree':
        # The destructive stage was removed. Keep the adversarial rename at
        # the final identity observation; both entries must survive intact.
        os.rename(path, root + '/moved-outside-attempt')
        moved = True
    return value
`,
  });
  expect(result.status).toBe("manual_attention");
  // Before the interleaving there are exactly .git and payload in this directory.
  expect(await readdir(join(f.root, "moved-outside-attempt"))).toHaveLength(2);
});

test.each([
  "cwd",
  "fd",
  "zombie_leader",
  "task_list_denied",
  "thread_reuse",
  "new_thread",
  "gone_thread",
  "clear",
])("review proof: independent thread state and visibility (%s)", (fault) => {
  const script = `${definitions}
import builtins, io, types
fault = sys.argv[1]
reads, calls = [], {}
def listing(path):
    reads.append(path)
    calls[path] = calls.get(path, 0) + 1
    if path == '/proc': return ['71']
    if path == '/proc/71/task':
        if fault == 'task_list_denied': raise PermissionError()
        if fault == 'new_thread' and calls[path] > 1: return ['71', '72', '73']
        if fault == 'gone_thread' and calls[path] > 1: return ['71']
        return ['71', '72']
    if path == '/proc/71/task/71/fd': return []
    if path == '/proc/71/task/72/fd': return ['3']
    raise AssertionError('unexpected list')
def opening(path, *args):
    reads.append(path)
    calls[path] = calls.get(path, 0) + 1
    if path.endswith('/stat'):
        state = 'Z' if fault == 'zombie_leader' and '/task/71/' in path else 'S'
        start = '200' if fault == 'thread_reuse' and '/task/72/' in path and calls[path] > 1 else '100'
        return io.StringIO('71 (fixture) ' + state + ' ' + '0 ' * 18 + start)
    if path.endswith('/wchan'): return io.StringIO('fixture_wait')
    raise AssertionError('forbidden process read')
def link(path):
    reads.append(path)
    if path == '/proc/71/task/72/cwd' and fault in ('cwd', 'zombie_leader'): return '/controlled/worktree'
    if path == '/proc/71/task/72/fd/3' and fault == 'fd': return '/controlled/worktree/payload'
    if path.endswith('/cwd') or path.endswith('/fd/3'): return '/elsewhere'
    raise AssertionError('unexpected link')
def metadata(path):
    return types.SimpleNamespace(st_dev=1, st_ino=99)
os.listdir, os.readlink, os.stat, builtins.open = listing, link, metadata, opening
try:
    scan(['/controlled'], {(1,10)})
    result = dict(status='clear')
except Occupied as error: result = dict(status='occupied', reason=error.reason, processes=error.processes)
print(json.dumps(dict(result=result, reads=reads)))
`;
  const result = spawnSync("python3", ["-I", "-c", script, fault], {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  const actual = JSON.parse(result.stdout);
  expect(actual.result.status).toBe(fault === "clear" ? "clear" : "occupied");
  if (["cwd", "fd", "zombie_leader"].includes(fault)) {
    expect(actual.result.processes).toEqual([
      { pid: 72, state: "S", wchan: "fixture_wait" },
    ]);
    expect(actual.reads).toContain(
      `/proc/71/task/72/${fault === "fd" ? "fd/3" : "cwd"}`,
    );
  } else if (fault !== "clear") expect(actual.result.reason).toBe("unverified");
  expect(
    actual.reads.every((path: string) =>
      /^\/proc(?:\/71\/task(?:\/(?:71|72)\/(?:stat|wchan|cwd|fd(?:\/3)?))?)?$/u.test(
        path,
      ),
    ),
  ).toBe(true);
});
