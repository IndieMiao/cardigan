import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { agentCoreCommand, agentSshCommand } from "./agent-ssh.js";
import type { ExecutionConfig } from "./execution.js";
import { MACOS_CORE_SCRIPT } from "./macos-core.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const config: Extract<ExecutionConfig, { mode: "agent-ssh" }> = {
  mode: "agent-ssh",
  dataDir: "/controller/data",
  agentRoot: "/workers/example",
  gid: 2201,
  machine: "example-a",
  user: "worker_fixture",
  identityFile: "/private/key",
  knownHostsFile: "/private/hosts",
};

test("Linux via is unchanged; macOS via carries one fixed connect command through both shell boundaries", () => {
  expect(agentCoreCommand(config, "cg")).toBe(agentSshCommand(config));
  const root = mkdtempSync(join(tmpdir(), "cg-via-"));
  roots.push(root);
  // Emulate OpenSSH's remote argv joining; execute no remote command.
  writeFileSync(
    join(root, "ssh"),
    "#!/usr/bin/python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n",
    { mode: 0o700 },
  );
  const entry = agentCoreCommand(
    {
      ...config,
      macosCore: {
        python: "/opt/homebrew/bin/python3",
        retiredLaunchdLabel: "dev.cardigan.example",
      },
    },
    "cg",
  );
  // Match Rust char::is_control in hc's real machine.add validation.
  expect(entry).not.toMatch(/\p{Cc}/u);
  const result = spawnSync(
    "sh",
    ["-c", `${entry} "$1"`, "sh", "untrusted appended command"],
    { encoding: "utf8", env: { PATH: `${root}:/usr/bin:/bin` } },
  );
  expect(result.status).toBe(0);
  const args = JSON.parse(result.stdout) as string[];
  expect(args).toContain("StrictHostKeyChecking=yes");
  expect(args.at(-1)).not.toContain("untrusted appended command");
  const remote = args.at(-1) as string;
  // A fake interpreter exposes exactly the cleaned environment and parsed args.
  writeFileSync(
    join(root, "python"),
    '#!/usr/bin/python3\nimport json,os,sys\ndecoded=[]\nexec(sys.argv[4], {"exec": lambda source: decoded.append(source.decode())})\nprint(json.dumps({"args":sys.argv[1:],"env":dict(os.environ),"decoded":decoded}))\n',
    { mode: 0o700 },
  );
  const parsed = spawnSync(
    "sh",
    ["-c", remote.replace("/opt/homebrew/bin/python3", join(root, "python"))],
    {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        SSH_CONNECTION: "fixture transport",
        SYNTHETIC_SECRET: "must-not-inherit",
        HC_SOCKET: "/wrong",
        XDG_STATE_HOME: "/wrong",
      },
    },
  );
  expect(parsed.status).toBe(0);
  const observed = JSON.parse(parsed.stdout);
  expect(observed.args).toEqual([
    "-I",
    "-B",
    "-c",
    expect.any(String),
    "cg",
    "dev.cardigan.example",
    "worker_fixture",
  ]);
  expect(observed.decoded).toEqual([MACOS_CORE_SCRIPT]);
  expect(observed.env).toMatchObject({
    HOME: root,
    SSH_CONNECTION: "fixture transport",
    HC_RUNTIME: "1",
  });
  for (const key of ["SYNTHETIC_SECRET", "HC_SOCKET", "XDG_STATE_HOME"])
    expect(observed.env[key]).toBeUndefined();
  expect(
    spawnSync("sh", ["-c", remote], {
      env: { PATH: "/usr/bin:/bin", HOME: root },
    }).status,
  ).not.toBe(0);
});

test.each([
  "plist",
  "plist-symlink",
  "plist-eacces",
  "plist-eio",
  "plist-enotdir",
  "plist-eloop",
  "loaded",
  "denied",
  "timeout",
  "wrong-label",
  "no-ssh",
  "wrong-user",
  "wrong-home",
])("macOS refuses competing or unproven ownership before hc: %s", (fault) => {
  const fixture = readFileSync(
    new URL("../test-support/macos-core-fixture.py", import.meta.url),
    "utf8",
  );
  const result = spawnSync(
    "python3",
    ["-I", "-B", "-c", fixture, fault, MACOS_CORE_SCRIPT],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("worker_macos_core_owner_conflict\n");
  expect(result.stdout).toBe("");
});

test("real entry delegates stale sockets and reconnects to hc; the synthetic hc lock keeps a single owner", () => {
  const fixture = readFileSync(
    new URL("../test-support/macos-core-fixture.py", import.meta.url),
    "utf8",
  );
  const result = spawnSync(
    "python3",
    ["-I", "-B", "-c", fixture, "lifecycle", MACOS_CORE_SCRIPT],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    connections: 3,
    generations: 2,
    competing_owner_rejected: true,
  });
});
