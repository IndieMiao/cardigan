import { execFileSync, spawnSync } from "node:child_process";
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
/**
 * curl's decision, as the real client makes it (V-3013): `no_proxy` when it
 * is non-empty, else `NO_PROXY`. Nothing listens on the port; `proxy_used`
 * tells which route each transfer took.
 */
function curlBypass(env: Env): boolean[] {
  const args = ["-q", "-s", "--max-time", "2"];
  for (const host of HOSTS)
    args.push(
      "--resolve",
      `${host}:9:127.0.0.1`,
      "-o",
      "/dev/null",
      "-w",
      "%{proxy_used}\\n",
      `http://${host}:9/`,
    );
  const out = spawnSync("curl", args, {
    env: { PATH, ...env, http_proxy: "http://127.0.0.1:9" },
  });
  if (out.error) throw out.error;
  const used = out.stdout.toString().trim().split("\n");
  expect(used).toHaveLength(HOSTS.length);
  return used.map((flag) => flag === "0");
}
const matches = (list: string) => {
  const entries = list
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return HOSTS.map((host) =>
    entries.some((entry) => {
      if (entry === "*") return true;
      const domain = entry.replace(/^\./u, "");
      return host === domain || host.endsWith(`.${domain}`);
    }),
  );
};
/** reqwest (Codex): `NO_PROXY` if set, even empty, else `no_proxy`. */
const reqwestBypass = (env: Env) => matches(env.NO_PROXY ?? env.no_proxy ?? "");
/** Go's httpproxy: the first non-empty of `NO_PROXY`, `no_proxy`. */
const goBypass = (env: Env) => matches(env.NO_PROXY || env.no_proxy || "");
const CLIENTS = ["urllib", "curl", "reqwest", "go"] as const;
type Client = (typeof CLIENTS)[number];
const routes = (env: Env): Record<Client, boolean[]> => ({
  urllib: urllibBypass(env),
  curl: curlBypass(env),
  reqwest: reqwestBypass(env),
  go: goBypass(env),
});
/** The spelling a client reads as an explicitly empty list, if any. */
const readsEmpty = (client: Client, env: Env) =>
  client === "urllib"
    ? env.no_proxy === ""
    : client === "reqwest"
      ? env.NO_PROXY === ""
      : !env.NO_PROXY && !env.no_proxy;
const proxyOnly = (env: Env): Env =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      ["NO_PROXY", "no_proxy"].includes(key),
    ),
  );
/**
 * No client's route to any other destination changes. The Card host
 * bypasses for every client, except one that still reads an explicitly
 * empty list; `strict` also requires that list to have been empty before
 * while the other spelling was a non-empty list (clients already disagreed).
 */
function expectOnlyCardChanged(before: Env, after: Env, strict = true) {
  const was = routes({ HTTPS_PROXY: PROXY, ...proxyOnly(before) });
  const now = routes({ HTTPS_PROXY: PROXY, ...proxyOnly(after) });
  for (const client of CLIENTS) {
    expect(now[client].slice(1), `${client} other hosts`).toEqual(
      was[client].slice(1),
    );
    const kept =
      client === "urllib"
        ? before.no_proxy === "" && !!before.NO_PROXY
        : client === "reqwest"
          ? before.NO_PROXY === "" && !!before.no_proxy
          : false;
    if (strict ? kept : readsEmpty(client, after))
      expect(readsEmpty(client, after), `${client} kept empty`).toBe(true);
    else expect(now[client][0], `${client} Card host`).toBe(true);
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
  // V-2999:2 — a spelling set to an empty value is not an unset one.
  { NO_PROXY: "" },
  { no_proxy: "" },
  { NO_PROXY: "", no_proxy: "" },
  { NO_PROXY: "*", no_proxy: "" },
  { NO_PROXY: "", no_proxy: "*" },
  { NO_PROXY: "localhost", no_proxy: "" },
  { NO_PROXY: "", no_proxy: ".lan" },
];
/** Profile (or settings) layer × account-inherited layer, incl. cross-spelling. */
const LAYERS: { profile: Env; inherited: Env }[] = [
  ...EXISTING.map((profile) => ({ profile, inherited: {} })),
  ...EXISTING.map((inherited) => ({ profile: {}, inherited })),
  {
    profile: { NO_PROXY: "localhost" },
    inherited: { no_proxy: "api.internal.invalid" },
  },
  {
    profile: { no_proxy: ".lan" },
    inherited: { NO_PROXY: "api.internal.invalid" },
  },
  {
    profile: { NO_PROXY: "localhost" },
    inherited: { NO_PROXY: "api.internal.invalid" },
  },
  {
    profile: { no_proxy: "*" },
    inherited: { NO_PROXY: "api.internal.invalid" },
  },
  {
    profile: { NO_PROXY: "other.invalid", no_proxy: "other.invalid" },
    inherited: { NO_PROXY: "api.internal.invalid", no_proxy: ".lan" },
  },
  // Explicitly empty spellings across the profile and account layers.
  { profile: { NO_PROXY: "*" }, inherited: { no_proxy: "" } },
  { profile: { no_proxy: "*" }, inherited: { NO_PROXY: "" } },
  { profile: { no_proxy: "" }, inherited: { NO_PROXY: "*" } },
  { profile: { NO_PROXY: "" }, inherited: { no_proxy: "*" } },
  { profile: { no_proxy: "" }, inherited: { no_proxy: ".lan" } },
  { profile: { NO_PROXY: "" }, inherited: { NO_PROXY: "localhost" } },
  {
    profile: { NO_PROXY: "localhost" },
    inherited: { NO_PROXY: "*", no_proxy: "" },
  },
  // V-3013:1: a NO_PROXY list beside an empty no_proxy (curl falls back).
  {
    profile: { NO_PROXY: "api.internal.invalid" },
    inherited: { no_proxy: "" },
  },
  { profile: { no_proxy: "" }, inherited: { NO_PROXY: "localhost,.lan" } },
  { profile: { NO_PROXY: "" }, inherited: { no_proxy: ".lan" } },
  { profile: { no_proxy: ".lan" }, inherited: { NO_PROXY: "" } },
  { profile: { no_proxy: " " }, inherited: { NO_PROXY: "localhost" } },
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
  const start =
    script.indexOf("export MCP_TOKEN\n") + "export MCP_TOKEN\n".length;
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
  // Empty while the other is a list: clients already disagree; stays empty.
  expect(launchProxyBypass(TAILNET, { NO_PROXY: "*", no_proxy: "" })).toEqual({
    NO_PROXY: "*",
    no_proxy: "",
  });
  expect(
    launchProxyBypass(TAILNET, { NO_PROXY: "", no_proxy: ".lan" }),
  ).toEqual({ NO_PROXY: "", no_proxy: `${CARD},.lan` });
  // Empty with nothing else listed: every client read "none"; gains the host.
  expect(launchProxyBypass(TAILNET, { NO_PROXY: "", no_proxy: "" })).toEqual({
    NO_PROXY: CARD,
    no_proxy: CARD,
  });
  expect(launchProxyBypass(TAILNET, { no_proxy: "" })).toEqual({
    NO_PROXY: CARD,
    no_proxy: CARD,
  });
  // Settings written before the account's lists are known stay conservative.
  expect(
    launchProxyBypass(
      TAILNET,
      { no_proxy: "" },
      { absentMayBeInherited: true },
    ),
  ).toEqual({ NO_PROXY: CARD, no_proxy: "" });
  expect(
    launchProxyBypass(
      TAILNET,
      { NO_PROXY: "", no_proxy: "" },
      { absentMayBeInherited: true },
    ),
  ).toEqual({ NO_PROXY: CARD, no_proxy: CARD });
});

test.each([
  // V-2999:2: urllib would start bypassing what it proxied.
  { profile: { NO_PROXY: "*" }, inherited: { no_proxy: "" } },
  // V-3013:1: curl would start proxying what it bypassed.
  {
    profile: { NO_PROXY: "api.internal.invalid" },
    inherited: { no_proxy: "" },
  },
])(
  "C-600 an empty no_proxy beside a NO_PROXY list keeps both urllib and curl routes (%o)",
  ({ profile, inherited }) => {
    const before = { ...inherited, ...profile };
    const was = routes({ HTTPS_PROXY: PROXY, ...before });
    // The two real clients already disagree on this configuration.
    expect(was.urllib.slice(1)).toEqual(HOSTS.slice(1).map(() => false));
    expect(was.curl[HOSTS.indexOf("api.internal.invalid")]).toBe(true);
    const providerEnv = { ...profile, HTTPS_PROXY: PROXY };
    const expected = {
      NO_PROXY: withMcpProxyBypass(profile.NO_PROXY, CARD),
      no_proxy: "",
    };
    const local = localEnv(compile("codex", { providerEnv }), inherited);
    const worker = workerEnv(
      compile("codex", { providerEnv, remote: true }),
      inherited,
    );
    for (const after of [local, worker]) {
      expect(after).toEqual(expected);
      expectOnlyCardChanged(before, after);
      // Codex (reqwest), curl and Go reach Card directly.
      const now = routes({ HTTPS_PROXY: PROXY, ...after });
      for (const client of ["reqwest", "curl", "go"] as const)
        expect(now[client][0], client).toBe(true);
    }
    // Unset is still not empty: an absent spelling takes the other's list.
    expect(localEnv(compile("codex", { providerEnv }), {})).toEqual({
      NO_PROXY: expected.NO_PROXY,
      no_proxy: expected.NO_PROXY,
    });
  },
);

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
      // The settings file cannot see the account's lists: an empty spelling
      // it sets may stay empty even when the account lists nothing.
      expectOnlyCardChanged({ ...inherited, ...profile }, effective, false);
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
