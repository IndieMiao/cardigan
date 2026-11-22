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
  "api.example.invalid",
];
const PROXY = "http://proxy.example.invalid:3128";

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
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } },
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
/** The Card host bypasses; every other destination keeps its route. */
function expectOnlyCardChanged(before: Env, after: Env) {
  const was = routes({ HTTPS_PROXY: PROXY, ...before });
  const now = routes({ HTTPS_PROXY: PROXY, ...after });
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
const launchScript = (compiled: ReturnType<typeof compile>) =>
  compiled.files.find((file) => file.path.endsWith("/launch.sh"))?.content ??
  "";
const launchJson = (compiled: ReturnType<typeof compile>) =>
  JSON.parse(
    compiled.files.find((file) => file.path.endsWith("/launch.json"))
      ?.content ?? "{}",
  ) as { env: Env; secret_keys?: string[] };
/** Run the launch.sh bypass block in sh with an inherited environment. */
function shellMerge(script: string, inherited: Env): Env {
  const start = script.indexOf("# C-600:");
  const end = script.indexOf("unset cardigan_upper cardigan_lower");
  expect(start).toBeGreaterThan(-1);
  const block = script.slice(start, end);
  const out = execFileSync(
    "/bin/sh",
    ["-euc", `${block}\nprintf '%s\\n%s' "$NO_PROXY" "$no_proxy"`],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...inherited } },
  )
    .toString()
    .split("\n");
  return { NO_PROXY: out[0] ?? "", no_proxy: out[1] ?? "" };
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

test.each(EXISTING)(
  "C-600 merged launch values only add the Card host to the client routes (%o)",
  (existing) => {
    expectOnlyCardChanged(existing, {
      ...existing,
      ...launchProxyBypass(TAILNET, existing),
    } as Env);
  },
);

test.each(["claude-code", "codex", "pi"] as const)(
  "C-600 %s launch material bypasses proxies for the Card MCP host",
  (harness) => {
    const remote = compile(harness, { remote: true });
    expect(remote.env).toMatchObject({ NO_PROXY: CARD, no_proxy: CARD });
    expect(launchJson(remote).env).toMatchObject({
      NO_PROXY: CARD,
      no_proxy: CARD,
    });
    // Explicit proxy variables are left to the account and the profile.
    expect(remote.env.HTTPS_PROXY).toBeUndefined();
    const local = compile(harness);
    expect(shellMerge(launchScript(local), {})).toEqual({
      NO_PROXY: CARD,
      no_proxy: CARD,
    });
  },
);

test.each(EXISTING)(
  "C-600 profile exceptions keep their routes in local and worker material (%o)",
  (existing) => {
    for (const remote of [false, true]) {
      const compiled = compile("codex", {
        remote,
        providerEnv: { ...existing, HTTPS_PROXY: PROXY },
      });
      const env = remote ? launchJson(compiled).env : compiled.env;
      expectOnlyCardChanged(existing, {
        NO_PROXY: env.NO_PROXY ?? "",
        no_proxy: env.no_proxy ?? "",
      });
      expect(env.HTTPS_PROXY).toBe(PROXY);
      if (!remote && Object.keys(existing).length)
        // Profile values are exported as compiled; no run-time merge.
        expect(launchScript(compiled)).not.toContain("cardigan_bypass");
    }
  },
);

test.each(EXISTING)(
  "C-600 local launch.sh keeps the account's inherited exceptions (%o)",
  (inherited) => {
    expectOnlyCardChanged(
      inherited,
      shellMerge(launchScript(compile("codex")), inherited),
    );
  },
);

test("C-600 a NO_PROXY declared as a provider secret is refused before any material", () => {
  for (const key of ["NO_PROXY", "no_proxy"])
    for (const remote of [false, true])
      expect(() =>
        compile("codex", {
          remote,
          providerSecrets: { [key]: "CREDENTIAL" },
        }),
      ).toThrow("NO_PROXY/no_proxy cannot be a provider secret");
});
