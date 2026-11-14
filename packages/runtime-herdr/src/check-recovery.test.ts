import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
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

test("removes only the bound ended checkout and its exact Git registration, then resumes idempotently", async () => {
  const f = await fixture();
  const sibling = join(f.root, "checks", "p", "other");
  f.git("worktree", "add", "--detach", sibling, f.sha);
  await writeFile(join(f.worktree, "payload"), "temporary");
  expect(f.run()).toMatchObject({ ready: true, status: "cleaned" });
  await expect(lstat(f.container)).rejects.toThrow();
  expect(f.git("worktree", "list", "--porcelain")).toContain(sibling);
  expect(f.git("worktree", "list", "--porcelain")).not.toContain(f.worktree);
  expect(f.run({ resume: true })).toMatchObject({ status: "cleaned" });
});

test("production path refuses an account-owned lock namespace", async () => {
  const f = await fixture();
  expect(f.run({ realProtection: true })).toMatchObject({
    ready: false,
    status: "manual_attention",
  });
  expect((await lstat(f.worktree)).isDirectory()).toBe(true);
});

test.each(["container", "registration"] as const)(
  "refuses a replaced %s even when it has the same name",
  async (key) => {
    const f = await fixture();
    const path = key === "container" ? f.container : f.registry;
    await rename(path, `${path}-old`);
    await mkdir(path, { mode: 0o700 });
    expect(f.run()).toMatchObject({ ready: false, status: "manual_attention" });
    expect((await lstat(`${path}-old`)).isDirectory()).toBe(true);
  },
);

test("rejects symlink ancestors and never follows an internal link outside the attempt", async () => {
  const f = await fixture();
  const outside = join(f.root, "keep");
  await writeFile(outside, "keep");
  await symlink(outside, join(f.worktree, "link"));
  expect(f.run()).toMatchObject({ status: "cleaned" });
  expect(await readFile(outside, "utf8")).toBe("keep");
  const g = await fixture();
  await rename(g.container, `${g.container}-old`);
  await symlink(`${g.container}-old`, g.container);
  expect(g.run()).toMatchObject({ ready: false, status: "manual_attention" });
});

test.each([
  "os.rename(root + '/checks/p/attempt', root + '/checks/p/moved')",
  "os.mkdir(root + '/checks/p/attempt/new')",
])(
  "rechecks identities and inventory after host authorization: %s",
  async (atAuthorize) => {
    const f = await fixture();
    expect(f.run({ atAuthorize })).toMatchObject({
      ready: true,
      status: "manual_attention",
    });
    expect((await lstat(f.registry)).isDirectory()).toBe(true);
  },
);

test("a foreign Git backlink or mount is never deletion authority", async () => {
  const f = await fixture();
  await writeFile(join(f.registry, "gitdir"), `${f.root}/elsewhere/.git\n`);
  expect(f.run()).toMatchObject({ ready: false, status: "manual_attention" });
  const g = await fixture();
  expect(
    g.run({
      before:
        "mounts = lambda: '1 0 0:0 / ' + sys.argv[1] + '/checks/p/attempt rw - tmpfs tmpfs rw'",
    }),
  ).toMatchObject({ ready: false, status: "manual_attention" });
});

test("retains every lock through deletion, and a held slot refuses recovery", async () => {
  const f = await fixture();
  expect(
    f.run({
      before: `
holder = os.open(sys.argv[1] + '/merge-check.lock', os.O_RDONLY)
fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)`,
    }),
  ).toMatchObject({ ready: false, status: "busy" });
});

test.each([
  "cwd",
  "fd",
  "renamed",
  "permission",
  "pid_reuse",
  "new_pid",
  "wchan",
  "clear",
])(
  "synthetic process evidence fails closed for %s without reading address-space files",
  (fault) => {
    const script = `${definitions}
import builtins, io, types
fault = sys.argv[1]
reads = []
stat_count = 0
list_count = 0
def listing(path):
    global list_count
    reads.append(path)
    if path == '/proc':
        list_count += 1
        return ['71', '72'] if fault == 'new_pid' and list_count > 1 else ['71']
    if path == '/proc/71/fd': return ['3']
    raise AssertionError('unexpected read')
def opening(path, *args):
    global stat_count
    reads.append(path)
    if path == '/proc/71/wchan':
        if fault == 'wchan': raise PermissionError()
        return io.StringIO('exit_mm')
    if path == '/proc/71/stat':
        stat_count += 1
        start = '200' if fault == 'pid_reuse' and stat_count > 1 else '100'
        return io.StringIO('71 (fixture) D ' + '0 ' * 18 + start)
    raise AssertionError('forbidden process read')
def link(path):
    reads.append(path)
    if fault == 'permission': raise PermissionError()
    if (fault == 'cwd' and path.endswith('/cwd')) or (fault == 'fd' and path.endswith('/3')): return '/controlled/worktree/file'
    return '/elsewhere'
def metadata(path):
    return types.SimpleNamespace(st_dev=1, st_ino=10 if fault == 'renamed' else 99)
os.listdir, os.readlink, os.stat, builtins.open = listing, link, metadata, opening
try:
    scan(['/controlled'], {(1, 10)})
    result = dict(status='clear')
except Occupied as error: result = dict(status='occupied', processes=error.processes)
except Exception: result = dict(status='unknown')
print(json.dumps(dict(result=result, reads=reads)))
`;
    const result = spawnSync("python3", ["-I", "-c", script, fault], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    const actual = JSON.parse(result.stdout);
    expect(actual.result.status).toBe(fault === "clear" ? "clear" : "occupied");
    expect(
      actual.reads.every((p: string) =>
        /^\/proc(?:\/71\/(?:stat|wchan|cwd|fd(?:\/3)?))?$/u.test(p),
      ),
    ).toBe(true);
    if (["cwd", "fd", "renamed"].includes(fault))
      expect(actual.result.processes).toEqual([
        { pid: 71, state: "D", wchan: "exit_mm" },
      ]);
  },
);

test("an interrupted deletion preserves registration and requires the host resume journal", async () => {
  const f = await fixture();
  await rm(join(f.worktree, ".git"));
  expect(f.run()).toMatchObject({ ready: false, status: "manual_attention" });
  expect(f.run({ resume: true })).toMatchObject({
    ready: true,
    status: "cleaned",
  });
});

test("a filesystem failure after the first unlink is audited as partial and can resume", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "remaining"), "preserve until retry");
  const partial = f.run({
    before: `
original_unlink = os.unlink
unlinked = 0
def unlink(*args, **kwargs):
    global unlinked
    unlinked += 1
    if unlinked > 1: raise OSError('fixture disk failure')
    original_unlink(*args, **kwargs)
os.unlink = unlink`,
  });
  expect(partial).toMatchObject({ ready: true, status: "manual_attention" });
  expect((await lstat(f.registry)).isDirectory()).toBe(true);
  expect(f.run({ resume: true })).toMatchObject({ status: "cleaned" });
});

test("a nested directory moved out during deletion is retained instead of traversed by its descriptor", async () => {
  const f = await fixture();
  await writeFile(join(f.worktree, "remaining"), "keep");
  await writeFile(join(f.worktree, "another"), "keep");
  const result = f.run({
    before: `
original_unlink = os.unlink
def unlink(*args, **kwargs):
    original_unlink(*args, **kwargs)
    os.rename(root + '/checks/p/attempt/worktree', root + '/moved')
os.unlink = unlink`,
  });
  expect(result.status).toBe("manual_attention");
  // Exactly the first unlink happened before the rename; iteration order is not prescribed.
  expect(await readdir(join(f.root, "moved"))).toHaveLength(2);
  expect((await lstat(f.registry)).isDirectory()).toBe(true);
});
