import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type DeviceInitPlan,
  deviceInitPlan,
  deviceInitScript,
  workerPublicKey,
} from "./device-init.js";

const exec = promisify(execFile);
const blob = Buffer.concat([
  Buffer.from("\0\0\0\x0bssh-ed25519\0\0\0\x20", "latin1"),
  Buffer.alloc(32, 7),
]).toString("base64");
const KEY = `restrict ssh-ed25519 ${blob}`;
const plan = (over: Partial<DeviceInitPlan> = {}): DeviceInitPlan => ({
  version: 1,
  os: "linux",
  project: "demo",
  account: "cg_demo",
  uid: 2000,
  gid: 2000,
  home: "/home/cg_demo",
  work: "/srv/cardigan-workers/demo",
  public_key: KEY,
  ...over,
});
const config = (over: {
  os?: string;
  home?: string;
  root?: string;
  user?: string;
  uid?: number;
}) =>
  ({
    uid: over.uid ?? 2000,
    home: over.home ?? "/home/cg_demo",
    worker: {
      os: over.os ?? "linux",
      project_id: "demo",
      execution: {
        user: over.user ?? "cg_demo",
        gid: 2000,
        agentRoot: over.root ?? "/srv/cardigan-workers/demo",
      },
    },
  }) as unknown as Parameters<typeof deviceInitPlan>[0];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-init-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("the host public key becomes one restricted Ed25519 line; anything else is refused", () => {
  writeFileSync(
    join(dir, "worker-key.pub"),
    `ssh-ed25519 ${blob} operator@private-host\n`,
  );
  expect(workerPublicKey(dir)).toBe(KEY);
  const refused = (content: string | null) => {
    rmSync(join(dir, "worker-key.pub"), { force: true });
    if (content !== null) writeFileSync(join(dir, "worker-key.pub"), content);
    expect(() => workerPublicKey(dir)).toThrow("worker_public_key_invalid");
  };
  refused(null);
  refused(`ssh-rsa ${blob}\n`);
  refused(`restrict ssh-ed25519 ${blob}\n`);
  refused(`ssh-ed25519 ${blob}\nssh-ed25519 ${blob}\n`);
  refused(`ssh-ed25519 ${Buffer.alloc(51, 1).toString("base64")}\n`);
  writeFileSync(join(dir, "real.pub"), `ssh-ed25519 ${blob}\n`);
  rmSync(join(dir, "worker-key.pub"));
  symlinkSync(join(dir, "real.pub"), join(dir, "worker-key.pub"));
  expect(() => workerPublicKey(dir)).toThrow("worker_public_key_invalid");
});

test("plans exist only for the fixed account, HOME and work-root layout", () => {
  expect(deviceInitPlan(config({}), KEY)).toEqual(plan());
  expect(
    deviceInitPlan(config({ root: "/home/cardigan-workers/demo" }), KEY).work,
  ).toBe("/home/cardigan-workers/demo");
  expect(
    deviceInitPlan(
      config({
        os: "darwin",
        home: "/Users/cg_demo",
        root: "/Users/cardigan-workers/demo",
      }),
      KEY,
    ),
  ).toEqual(
    plan({
      os: "darwin",
      home: "/Users/cg_demo",
      work: "/Users/cardigan-workers/demo",
    }),
  );
  for (const bad of [
    config({ home: "/root" }),
    config({ home: "/home/other" }),
    config({ root: "/etc/cardigan-workers/demo" }),
    config({ root: "/srv/cardigan-workers/other" }),
    config({ os: "darwin" }),
    config({ user: "root" }),
    config({ uid: 0 }),
  ])
    expect(() => deviceInitPlan(bad, KEY)).toThrow("device_init_unsupported");
  expect(() => deviceInitPlan(config({}), `${KEY} x`)).toThrow(
    "device_init_unsupported",
  );
});

const HARNESS = `import contextlib, importlib.util, io, json, os, sys
path, root, scenario = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
spec = importlib.util.spec_from_file_location('device_init', path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
if 'plan' in scenario:
    mod.PLAN = scenario['plan']
mod.PREFIX = root
mod.MIN_FREE = 1
taken, log, owners = scenario.get('taken', {}), [], {}
mod.is_root = lambda: True
mod.current_os = lambda: scenario.get('os', 'linux')
def chown(fd, uid, gid):
    owners[os.fstat(fd).st_ino] = [uid, gid]
mod.chown = chown
def run(argv):
    log.append(['run'] + [a[len(root):] if a.startswith(root) else a for a in argv])
    if scenario.get('fail') == os.path.basename(argv[0]):
        raise mod.Failed('%s 退出码 1' % os.path.basename(argv[0]))
    return ''
mod.run = run
mod.tool = lambda name: '/usr/sbin/' + name
mod.user_taken = lambda name=None, uid=None: name in taken.get('names', []) or uid in taken.get('ids', [])
mod.group_taken = lambda name=None, gid=None: name in taken.get('groups', []) or gid in taken.get('ids', [])
mod.directory_records = lambda kind, attribute: taken.get('records', [])
mod.account_record = lambda name: tuple(scenario['record'])
mod.mount_of = lambda system, path: '/'
listing = list(scenario.get('listing', ['denied']))
def sudo_listing(account):
    log.append(['sudo_listing', account])
    return listing.pop(0)
mod.sudo_listing = sudo_listing
def install_layout(system, project, files):
    log.append(['install_layout', system, project, sorted(files)])
    if scenario.get('fail') == 'installer':
        raise mod.Failed('安装器退出码 1')
mod.install_layout = install_layout
out, err = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    code = mod.main(scenario.get('argv', []))
tree = {}
for base, dirs, files in os.walk(root):
    for name in dirs + files:
        full = os.path.join(base, name)
        info = os.lstat(full)
        tree[full[len(root):]] = {
            'mode': oct(info.st_mode & 0o7777),
            'owner': owners.get(info.st_ino),
            'text': open(full).read() if os.path.isfile(full) else None,
        }
print(json.dumps({'code': code, 'log': log, 'tree': tree, 'out': out.getvalue(), 'err': err.getvalue()}))`;

interface Outcome {
  code: number;
  log: unknown[][];
  tree: Record<
    string,
    { mode: string; owner: [number, number] | null; text: string | null }
  >;
  out: string;
  err: string;
}
async function scenario(
  script: string,
  s: Record<string, unknown> = {},
  root = mkdtempSync(join(dir, "fs-")),
): Promise<Outcome> {
  const file = join(dir, "device-init.py");
  writeFileSync(file, script);
  const darwin = s.os === "darwin";
  for (const d of darwin
    ? ["Users", "Library", "private/etc/sudoers.d"]
    : ["home", "srv", "etc/sudoers.d"])
    mkdirSync(join(root, d), { recursive: true });
  const { stdout } = await exec(
    "python3",
    [
      "-IB",
      "-c",
      HARNESS,
      file,
      root,
      JSON.stringify({
        record: darwin
          ? [2000, 2000, "/Users/cg_demo"]
          : [2000, 2000, "/home/cg_demo"],
        ...s,
      }),
    ],
    { timeout: 20_000 },
  );
  return JSON.parse(stdout) as Outcome;
}
const before = (o: Outcome) =>
  Object.keys(o.tree).filter(
    (p) =>
      !/^\/(home|srv|etc|etc\/sudoers\.d|Users|Library|private|private\/etc|private\/etc\/sudoers\.d)$/u.test(
        p,
      ),
  );

test("the generated script carries only the plan and the release installer, and lists its fixed actions", async () => {
  const script = deviceInitScript(plan());
  expect(script).not.toContain("# @plan");
  expect(script).not.toContain("# @files");
  const embedded =
    /^FILES = json\.loads\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/mu.exec(
      script,
    )?.[1];
  const files = JSON.parse(
    Buffer.from(embedded ?? "", "base64").toString(),
  ) as Record<string, string>;
  for (const name of [
    "install-macos-worker.py",
    "install-linux-worker.py",
    "worker-primitives.py",
  ])
    expect(Buffer.from(files[name] ?? "", "base64")).toEqual(
      readFileSync(new URL(`../../../deploy/${name}`, import.meta.url)),
    );
  expect(Object.keys(files)).toHaveLength(3);
  const listed = await scenario(script, { argv: ["--list"] });
  expect(listed.code).toBe(0);
  expect(listed.out.trim().split("\n")).toHaveLength(8);
  expect(listed.out).toContain("cg_demo（UID 2000）");
  expect(listed.out).toContain("listpw=never");
  expect(listed.out).toContain("不修改 /etc/sudoers");
  expect(before(listed)).toEqual([]);
});

test("a Linux run creates exactly the listed account, directories, key, markers and binding", async () => {
  const o = await scenario(deviceInitScript(plan()));
  expect(o.code, o.err).toBe(0);
  expect(o.log).toEqual([
    ["run", "/usr/sbin/groupadd", "--gid", "2000", "cg_demo"],
    [
      "run",
      "/usr/sbin/useradd",
      "--uid",
      "2000",
      "--gid",
      "2000",
      "--home-dir",
      "/home/cg_demo",
      "--no-create-home",
      "--shell",
      "/bin/sh",
      "cg_demo",
    ],
    [
      "install_layout",
      "linux",
      "demo",
      [
        "install-linux-worker.py",
        "install-macos-worker.py",
        "worker-primitives.py",
      ],
    ],
    ["sudo_listing", "cg_demo"],
  ]);
  const entry = (mode: string, owner: [number, number]) =>
    expect.objectContaining({ mode, owner });
  expect(o.tree).toEqual({
    "/home": expect.anything(),
    "/srv": expect.anything(),
    "/etc": expect.anything(),
    "/etc/sudoers.d": expect.anything(),
    "/home/cg_demo": entry("0o750", [0, 2000]),
    "/home/cg_demo/.ssh": entry("0o750", [0, 2000]),
    "/home/cg_demo/.ssh/authorized_keys": {
      mode: "0o640",
      owner: [0, 2000],
      text: `${KEY}\n`,
    },
    "/home/cg_demo/.local": entry("0o750", [0, 2000]),
    "/home/cg_demo/.local/bin": entry("0o750", [0, 2000]),
    "/home/cg_demo/.local/state": entry("0o700", [2000, 2000]),
    "/home/cg_demo/.local/share": entry("0o700", [2000, 2000]),
    "/home/cg_demo/.config": entry("0o700", [2000, 2000]),
    "/home/cg_demo/.cache": entry("0o700", [2000, 2000]),
    "/home/cg_demo/.cardigan-project": {
      mode: "0o644",
      owner: [0, 0],
      text: '{"project": "demo", "uid": 2000}',
    },
    "/srv/cardigan-workers": entry("0o755", [0, 0]),
    "/srv/cardigan-workers/demo": entry("0o750", [0, 2000]),
    "/srv/cardigan-workers/demo/.cardigan-worker": entry("0o600", [0, 0]),
    "/etc/cardigan": entry("0o700", [0, 0]),
    "/etc/cardigan/worker-demo.json": entry("0o600", [0, 0]),
  });
  expect(
    JSON.parse(
      o.tree["/srv/cardigan-workers/demo/.cardigan-worker"]?.text ?? "",
    ),
  ).toEqual({ project: "demo", uid: 2000, home: "/home/cg_demo" });
  expect(
    JSON.parse(o.tree["/etc/cardigan/worker-demo.json"]?.text ?? ""),
  ).toEqual({
    account: "cg_demo",
    uid: 2000,
    project: "demo",
    root: "/srv/cardigan-workers/demo",
    mount: "/",
    volume: expect.stringMatching(/^\d+$/u),
    minimum_free_bytes: { root: 1, work: 1 },
    timeout_ms: 15000,
  });
  expect(o.out).toContain("初始化完成");
});

test("the sudo listing default is added only when the account is asked for a password", async () => {
  const o = await scenario(deviceInitScript(plan()), {
    listing: ["password", "denied"],
  });
  expect(o.code, o.err).toBe(0);
  expect(o.log.slice(-3)).toEqual([
    ["sudo_listing", "cg_demo"],
    [
      "run",
      "/usr/sbin/visudo",
      "-cf",
      "/etc/sudoers.d/cardigan-worker-cg_demo.new",
    ],
    ["sudo_listing", "cg_demo"],
  ]);
  expect(o.tree["/etc/sudoers.d/cardigan-worker-cg_demo"]).toEqual({
    mode: "0o440",
    owner: [0, 0],
    text: "Defaults:cg_demo listpw=never\n",
  });
  expect(o.tree["/etc/sudoers.d/cardigan-worker-cg_demo.new"]).toBeUndefined();

  // Anything but a clear refusal afterwards fails; nothing is undone silently.
  const still = await scenario(deviceInitScript(plan()), {
    listing: ["password", "other"],
  });
  expect(still.code).toBe(1);
  expect(still.err).toContain("没有得到明确拒绝");
  expect(still.err).toContain(
    "sudo rm -r -- /etc/sudoers.d/cardigan-worker-cg_demo",
  );
  const granted = await scenario(deviceInitScript(plan()), {
    listing: ["other"],
  });
  expect(granted.code).toBe(1);
  expect(
    granted.tree["/etc/sudoers.d/cardigan-worker-cg_demo"],
  ).toBeUndefined();
});

test.each([
  [{ taken: { names: ["cg_demo"] } }, "账号 cg_demo 已存在"],
  [{ taken: { ids: [2000] } }, "UID 2000 已被占用"],
  [{ taken: { groups: ["cg_demo"] } }, "组 cg_demo 已存在"],
  [{ dirs: ["/home/cg_demo"] }, "/home/cg_demo 已存在"],
  [
    { dirs: ["/srv/cardigan-workers/demo"] },
    "/srv/cardigan-workers/demo 已存在",
  ],
  [{ dirs: ["/srv/cardigan-workers"] }, "不是 root 持有的 0755 目录"],
  [
    { dirs: ["/etc/cardigan"] },
    "/etc/cardigan 已存在但不是 root 持有的 0700 目录",
  ],
  [
    { files: ["/etc/sudoers.d/cardigan-worker-cg_demo"] },
    "cardigan-worker-cg_demo 已存在",
  ],
])("a conflict (%j) stops before any change", async (s, message) => {
  const {
    dirs = [],
    files = [],
    ...rest
  } = s as {
    dirs?: string[];
    files?: string[];
  };
  const root = mkdtempSync(join(dir, "fs-"));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "{}");
  }
  const o = await scenario(deviceInitScript(plan()), rest, root);
  expect(o.code).toBe(3);
  expect(o.err).toContain(message);
  expect(o.err).toContain("未做任何改动");
  expect(o.log).toEqual([]);
  expect(Object.values(o.tree).filter((e) => e.owner !== null)).toEqual([]);
});

test("a failure after changes reports what exists and how to remove it, without undoing", async () => {
  const o = await scenario(deviceInitScript(plan()), { fail: "installer" });
  expect(o.code).toBe(1);
  expect(o.err).toContain("初始化失败：安装器退出码 1");
  const hints = o.err.split("\n").filter((l) => l.startsWith("  sudo"));
  expect(hints).toEqual([
    "  sudo rm -r -- /etc/cardigan",
    "  sudo rm -r -- /srv/cardigan-workers",
    "  sudo rm -r -- /home/cg_demo",
    "  sudo userdel cg_demo",
    "  sudo groupdel cg_demo",
  ]);
  expect(o.tree["/home/cg_demo/.ssh/authorized_keys"]).toBeDefined();
});

test("macOS uses dscl and the macOS paths; a read-only-root Linux plan uses /home", async () => {
  const mac = await scenario(
    deviceInitScript(
      plan({
        os: "darwin",
        home: "/Users/cg_demo",
        work: "/Users/cardigan-workers/demo",
      }),
    ),
    { os: "darwin" },
  );
  expect(mac.code, mac.err).toBe(0);
  expect(mac.log.filter((l) => l[0] === "run")).toEqual([
    ["run", "/usr/bin/dscl", ".", "-create", "/Groups/cg_demo"],
    [
      "run",
      "/usr/bin/dscl",
      ".",
      "-create",
      "/Groups/cg_demo",
      "PrimaryGroupID",
      "2000",
    ],
    ["run", "/usr/bin/dscl", ".", "-create", "/Users/cg_demo"],
    [
      "run",
      "/usr/bin/dscl",
      ".",
      "-create",
      "/Users/cg_demo",
      "UniqueID",
      "2000",
    ],
    [
      "run",
      "/usr/bin/dscl",
      ".",
      "-create",
      "/Users/cg_demo",
      "PrimaryGroupID",
      "2000",
    ],
    [
      "run",
      "/usr/bin/dscl",
      ".",
      "-create",
      "/Users/cg_demo",
      "NFSHomeDirectory",
      "/Users/cg_demo",
    ],
    [
      "run",
      "/usr/bin/dscl",
      ".",
      "-create",
      "/Users/cg_demo",
      "UserShell",
      "/bin/sh",
    ],
  ]);
  expect(mac.tree["/Library/Cardigan/worker-demo.json"]).toBeDefined();
  expect(mac.tree["/Users/cardigan-workers/demo"]).toBeDefined();
  const record = await scenario(
    deviceInitScript(
      plan({
        os: "darwin",
        home: "/Users/cg_demo",
        work: "/Users/cardigan-workers/demo",
      }),
    ),
    { os: "darwin", taken: { records: [["cg_other", "2000"]] } },
  );
  expect(record.code).toBe(3);

  const deck = await scenario(
    deviceInitScript(plan({ work: "/home/cardigan-workers/demo" })),
  );
  expect(deck.code, deck.err).toBe(0);
  expect(deck.tree["/home/cardigan-workers"]).toMatchObject({
    mode: "0o755",
    owner: [0, 0],
  });
  expect(deck.tree["/srv/cardigan-workers"]).toBeUndefined();
});

test("an altered plan cannot widen the scope", async () => {
  for (const bad of [
    { ...plan(), home: "/root" },
    { ...plan(), work: "/etc/demo" },
    { ...plan(), account: "root" },
    { ...plan(), uid: 0 },
    { ...plan(), public_key: `${KEY} extra` },
    { ...plan(), public_key: `command="sh" ${KEY.slice(9)}` },
    { ...plan(), extra: 1 },
    { ...plan(), os: "windows" },
  ]) {
    const o = await scenario(deviceInitScript(plan()), { plan: bad });
    expect(o.code, JSON.stringify(bad)).toBe(2);
    expect(o.err).toContain("初始化脚本内容无效");
    expect(o.log).toEqual([]);
  }
  const mismatch = await scenario(deviceInitScript(plan()), { os: "darwin" });
  expect(mismatch.code).toBe(2);
});

test("run for real without root it refuses, and a script file deletes itself", async () => {
  const file = join(dir, "init.py");
  writeFileSync(file, deviceInitScript(plan()));
  const listed = await exec("python3", ["-IB", file, "--list"]);
  expect(listed.stdout).toContain("cg_demo");
  expect(existsSync(file)).toBe(true);
  const refused = await exec("python3", ["-IB", file]).then(
    () => 0,
    (e: { code: number; stderr: string }) => e,
  );
  if (process.getuid?.() !== 0) {
    expect(refused).toMatchObject({ code: 2 });
    expect(existsSync(file)).toBe(false);
  }
  // From standard input nothing is written in the first place.
  const piped = execFile("python3", ["-IB", "-", "--list"]);
  piped.stdin?.end(deviceInitScript(plan()));
  const code = await new Promise((ok) => piped.on("close", ok));
  expect(code).toBe(0);
});
