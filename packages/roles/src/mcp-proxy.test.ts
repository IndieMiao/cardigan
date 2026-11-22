import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  compileAssignmentLaunch,
  mcpProxyBypassHost,
  parseLaunchConfig,
  withMcpProxyBypass,
} from "./index.js";

const TAILNET = "https://control.example-tailnet.ts.net:8443/mcp";

function compile(
  harness: "claude-code" | "codex" | "pi",
  options: {
    url?: string;
    remote?: boolean;
    providerEnv?: Record<string, string>;
  } = {},
) {
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
      ...(options.providerEnv
        ? {
            providers: {
              routed: { harness, env: options.providerEnv },
            },
          }
        : {}),
      profiles: {
        fixture: {
          harness,
          ...(options.providerEnv ? { provider: "routed" } : {}),
        },
      },
    }),
    mcp: { url: options.url ?? TAILNET },
    run_dir: "/fixture/runs/A-1",
    work_dir: "/fixture/worktrees/A-1",
    first_prompt: "hello",
    secrets: {},
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

test("C-600 the NO_PROXY entry is the bare Card MCP host", () => {
  expect(mcpProxyBypassHost(TAILNET)).toBe("control.example-tailnet.ts.net");
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
});

test.each(["claude-code", "codex", "pi"] as const)(
  "C-600 %s launch material bypasses proxies for the Card MCP host",
  (harness) => {
    for (const remote of [false, true]) {
      const compiled = compile(harness, { remote });
      expect(compiled.env.NO_PROXY).toBe("control.example-tailnet.ts.net");
      expect(compiled.env.no_proxy).toBe("control.example-tailnet.ts.net");
      // Explicit proxy variables are left to the account and the profile.
      expect(compiled.env.HTTPS_PROXY).toBeUndefined();
      const material =
        compiled.files.find((file) =>
          file.path.endsWith(remote ? "/launch.json" : "/launch.sh"),
        )?.content ?? "";
      if (remote)
        expect(JSON.parse(material).env).toMatchObject({
          NO_PROXY: "control.example-tailnet.ts.net",
          no_proxy: "control.example-tailnet.ts.net",
        });
      else
        expect(material).toContain(
          `export NO_PROXY='control.example-tailnet.ts.net'"\${NO_PROXY:+,$NO_PROXY}"`,
        );
    }
  },
);

test("C-600 a profile's own NO_PROXY entries are kept after the MCP host", () => {
  const compiled = compile("codex", {
    providerEnv: {
      NO_PROXY: "localhost,.corp.invalid",
      HTTPS_PROXY: "http://proxy.invalid:3128",
    },
  });
  expect(compiled.env.NO_PROXY).toBe(
    "control.example-tailnet.ts.net,localhost,.corp.invalid",
  );
  expect(compiled.env.no_proxy).toBe("control.example-tailnet.ts.net");
  expect(compiled.env.HTTPS_PROXY).toBe("http://proxy.invalid:3128");
});

test("C-600 local launch.sh keeps the account's inherited bypass list", () => {
  const script =
    compile("codex")
      .files.find((file) => file.path.endsWith("/launch.sh"))
      ?.content.split("\n")
      .filter((line) => /^export (NO_PROXY|no_proxy)=/u.test(line))
      .join("\n") ?? "";
  const run = (env: Record<string, string>) =>
    execFileSync(
      "/bin/sh",
      ["-euc", `${script}\nprintf '%s|%s' "$NO_PROXY" "$no_proxy"`],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } },
    ).toString();
  expect(run({})).toBe(
    "control.example-tailnet.ts.net|control.example-tailnet.ts.net",
  );
  expect(run({ NO_PROXY: "localhost", no_proxy: ".lan" })).toBe(
    "control.example-tailnet.ts.net,localhost|control.example-tailnet.ts.net,.lan",
  );
});
