import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  compileAssignmentLaunch,
  launchProxyBypass,
  mcpProxyBypassHost,
  parseLaunchConfig,
  withMcpProxyBypass,
} from "./index.js";

const TAILNET = "https://control.example-tailnet.ts.net:8443/mcp";
const CARD = "control.example-tailnet.ts.net";
/** Destinations whose route must not change, plus the Card host itself. */
const HOSTS = [
  CARD,
  "localhost",
  "service.corp.invalid",
  "box.lan",
  "api.internal.invalid",
  "api.example.invalid",
];
const PROXY = "http://proxy.example.invalid:3128";
const PATH = process.env.PATH ?? "/usr/bin:/bin";

type Env = Record<string, string>;

/** Python urllib's decision (lower case wins), as the real client makes it. */
function urllibBypass(env: Env): boolean[] {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-I",
        "-c",
        "import json, sys, urllib.request as u\nprint(json.dumps([bool(u.proxy_bypass_environment(h)) for h in sys.argv[1:]]))",
        ...HOSTS,
      ],
      { env: { PATH, ...env } },
    ).toString(),
  );
}
/** reqwest's NO_PROXY rule (upper case first, `*` anywhere, domain suffix). */
function reqwestBypass(env: Env): boolean[] {
  const list = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return HOSTS.map((host) =>
    list.some((entry) => {
      if (entry === "*") return true;
      const domain = entry.replace(/^\./u, "");
      return host === domain || host.endsWith(`.${domain}`);
    }),
  );
}
const routes = (env: Env) => ({
  urllib: urllibBypass(env),
  reqwest: reqwestBypass(env),
});
const proxyOnly = (env: Env): Env =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      ["NO_PROXY", "no_proxy"].includes(key),
    ),
  );
/** The Card host bypasses; every other destination keeps its route. */
function expectOnlyCardChanged(before: Env, after: Env) {
  const was = routes({ HTTPS_PROXY: PROXY, ...proxyOnly(before) });
  const now = routes({ HTTPS_PROXY: PROXY, ...proxyOnly(after) });
  for (const client of ["urllib", "reqwest"] as const) {
    expect(now[client][0], `${client} Card host`).toBe(true);
    expect(now[client].slice(1), `${client} other hosts`).toEqual(
      was[client].slice(1),
    );
  }
}
const EXISTING: Env[] = [
  {},
  { NO_PROXY: "localhost,.corp.invalid" },
  { no_proxy: ".lan" },
  { NO_PROXY: "localhost", no_proxy: ".lan,service.corp.invalid" },
  { NO_PROXY: "*" },
  { no_proxy: "*" },
  { NO_PROXY: "localhost, * " },
];
/** Profile (or settings) layer × account-inherited layer, incl. cross-spelling. */
const LAYERS: { profile: Env; inherited: Env }[] = [
  ...EXISTING.map((profile) => ({ profile, inherited: {} })),
  ...EXISTING.map((inherited) => ({ profile: {}, inherited })),
  { profile: { NO_PROXY: "localhost" }, inherited: { no_proxy: "api.internal.invalid" } },
  { profile: { no_proxy: ".lan" }, inherited: { NO_PROXY: "api.internal.invalid" } },
  { profile: { NO_PROXY: "localhost" }, inherited: { NO_PROXY: "api.internal.invalid" } },
  { profile: { no_proxy: "*" }, inherited: { NO_PROXY: "api.internal.invalid" } },
  {
    profile: { NO_PROXY: "other.invalid", no_proxy: "other.invalid" },
    inherited: { NO_PROXY: "api.internal.invalid", no_proxy: ".lan" },
  },
];

function compile(
  harness: "claude-code" | "codex" | "pi",
  options: {
    url?: string;
    remote?: boolean;
    providerEnv?: Env;
    providerSecrets?: Env;
  } = {},
) {
  const routed = options.providerEnv || options.providerSecrets;
  return compileAssignmentLaunch({
    assignment: { assignment_id: "A-1", run_id: "R-1" },
    role: {
      role_id: "coder",
      harness,
      launch_profile: "fixture",
      core_prompt: "Fixture",
      allowed_tools: ["whoami"],
      worktree: "write",
    },
    launch: parseLaunchConfig({
      ...(routed
        ? {
            providers: {
              routed: {
                harness,
                ...(options.providerEnv ? { env: options.providerEnv } : {}),
                ...(options.providerSecrets
                  ? { secret_env: options.providerSecrets }
                  : {}),
              },
            },
          }
        : {}),
      profiles: {
        fixture: { harness, ...(routed ? { provider: "routed" } : {}) },
      },
    }),
    mcp: { url: options.url ?? TAILNET },
    run_dir: "/fixture/runs/A-1",
    work_dir: "/fixture/worktrees/A-1",
    first_prompt: "hello",
    secrets: { CREDENTIAL: "synthetic" },
    ...(options.remote
      ? {
          worker_launch: {
            command: ["fixture-worker"],
            session_dir: "/fixture/session",
          },
        }
      : {}),
  });
}
type Compiled = ReturnType<typeof compile>;
const fileEnding = (compiled: Compiled, ending: string) =>
  compiled.files.find((file) => file.path.endsWith(ending))?.content ?? "";
const launchJson = (compiled: Compiled) =>
  JSON.parse(fileEnding(compiled, "/launch.json") || "{}") as {
    command: string;
    args: string[];
    env: Env;
    secret_keys?: string[];
  };
/** Claude's own settings env, which overrides the process environment. */
const claudeSettings = (compiled: Compiled): Env =>
  (
    JSON.parse(
      compiled.files.find((file) => file.path.endsWith(".claude-settings.json"))
        ?.content ?? "{}",
    ) as { env?: Env }
  ).env ?? {};
const printEnv = `printf '%s\\n%s' "\${NO_PROXY-<unset>}" "\${no_proxy-<unset>}"`;
const parsePrinted = (out: string): Env => {
  const [upper, lower] = out.split("\n");
  return {
    ...(upper === "<unset>" ? {} : { NO_PROXY: upper ?? "" }),
    ...(lower === "<unset>" ? {} : { no_proxy: lower ?? "" }),
  };
};
/** Run the local launch.sh exports and bypass block in sh with `inherited`. */
function localEnv(compiled: Compiled, inherited: Env): Env {
  const script = fileEnding(compiled, "/launch.sh");
  const start = script.indexOf("export MCP_TOKEN\n") + "export MCP_TOKEN\n".length;
  const end = script.indexOf("# Git's legacy");
  const block = script
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.startsWith("export CARDIGAN_SESSION"))
    .join("\n");
  return parsePrinted(
    execFileSync("/bin/sh", ["-euc", `${block}\n${printEnv}`], {
      env: { PATH, ...inherited },
    }).toString(),
  );
}
/** What the worker helper execs: launch env over inherited, then launch.json's command. */
function workerEnv(compiled: Compiled, inherited: Env): Env {
  const launch = launchJson(compiled);
  expect(launch.command).toBe("/bin/sh");
  const [flag, script, harness] = launch.args;
  expect(flag).toBe("-c");
  expect(harness).toBe(compiled.command);
  // Replace the CLI with a printer: same argv shape, same exec step.
  return parsePrinted(
    execFileSync(
      "/bin/sh",
      ["-c", (script ?? "").replace('exec "$0" "$@"', printEnv), harness ?? ""],
      { env: { PATH, ...inherited, ...launch.env } },
    ).toString(),
  );
}

test("C-600 the NO_PROXY entry is the bare Card MCP host and `*` lists stay as they are", () => {
  expect(mcpProxyBypassHost(TAILNET)).toBe(CARD);
  expect(mcpProxyBypassHost("http://127.0.0.1:3004/mcp")).toBe("127.0.0.1");
  expect(mcpProxyBypassHost("http://[::1]:3004/mcp")).toBe("::1");
  expect(mcpProxyBypassHost("HTTPS://Control.Example.ts.net/mcp")).toBe(
    "control.example.ts.net",
  );
  expect(mcpProxyBypassHost("not a url")).toBeUndefined();
  expect(withMcpProxyBypass(undefined, "a.ts.net")).toBe("a.ts.net");
  expect(withMcpProxyBypass(" localhost, A.ts.net ,,.corp", "a.ts.net")).toBe(
    "a.ts.net,localhost,.corp",
  );
  expect(withMcpProxyBypass("*", "a.ts.net")).toBe("*");
  expect(withMcpProxyBypass(" * ", "a.ts.net")).toBe(" * ");
  expect(withMcpProxyBypass("localhost, * ", "a.ts.net")).toBe(
    "a.ts.net,localhost,*",
  );
  // An unset spelling takes the other one's entries instead of shadowing them.
  expect(launchProxyBypass(TAILNET, { NO_PROXY: "localhost" })).toEqual({
    NO_PROXY: `${CARD},localhost`,
    no_proxy: `${CARD},localhost`,
  });
});

test.each(LAYERS)(
  "C-600 codex local and worker launches only add the Card host to the routes (%o)",
  ({ profile, inherited }) => {
    // Before: the launch exported the profile values over the account's.
    const before = { ...inherited, ...profile };
    const providerEnv = { ...profile, HTTPS_PROXY: PROXY };
    expectOnlyCardChanged(
      before,
      localEnv(compile("codex", { providerEnv }), inherited),
    );
    expectOnlyCardChanged(
      before,
      workerEnv(compile("codex", { providerEnv, remote: true }), inherited),
    );
  },
);

test.each(LAYERS)(
  "C-600 Claude's settings keep the Card exception that the process environment carries (%o)",
  ({ profile, inherited }) => {
    for (const remote of [false, true]) {
      const compiled = compile("claude-code", {
        remote,
        providerEnv: { ...profile, HTTPS_PROXY: PROXY },
      });
      const settings = claudeSettings(compiled);
      // Settings override the process inside Claude, before and after.
      const processEnv = remote
        ? workerEnv(compiled, inherited)
        : localEnv(compiled, inherited);
      const effective = { ...processEnv, ...proxyOnly(settings) };
      expectOnlyCardChanged({ ...inherited, ...profile }, effective);
      expect(settings.HTTPS_PROXY).toBe(PROXY);
      for (const key of ["NO_PROXY", "no_proxy"] as const)
        expect(Object.hasOwn(settings, key)).toBe(Object.hasOwn(profile, key));
    }
  },
);

test.each(["claude-code", "codex", "pi"] as const)(
  "C-600 %s launch material bypasses proxies for the Card MCP host",
  (harness) => {
    const remote = compile(harness, { remote: true });
    expect(remote.env).toMatchObject({ NO_PROXY: CARD, no_proxy: CARD });
    const launch = launchJson(remote);
    // The worker merges with what the account inherits; nothing is fixed here.
    expect(launch.env).not.toHaveProperty("NO_PROXY");
    expect(launch.env).not.toHaveProperty("no_proxy");
    expect(launch.args.slice(2)).toEqual([remote.command, ...remote.args]);
    expect(workerEnv(remote, {})).toEqual({ NO_PROXY: CARD, no_proxy: CARD });
    // Explicit proxy variables are left to the account and the profile.
    expect(remote.env.HTTPS_PROXY).toBeUndefined();
    expect(localEnv(compile(harness), {})).toEqual({
      NO_PROXY: CARD,
      no_proxy: CARD,
    });
  },
);

test("C-600 a NO_PROXY declared as a provider secret is refused before any material", () => {
  for (const harness of ["codex", "claude-code"] as const)
    for (const key of ["NO_PROXY", "no_proxy"])
      for (const remote of [false, true])
        expect(() =>
          compile(harness, {
            remote,
            providerSecrets: { [key]: "CREDENTIAL" },
          }),
        ).toThrow("NO_PROXY/no_proxy cannot be a provider secret");
});
