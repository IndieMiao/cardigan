import { expect, test } from "vitest";
import { launchWarnings, reportLaunchWarnings } from "./launch-diagnostics.js";
import { parseLaunchConfig } from "./schema.js";

const config = (profile: object = {}) =>
  parseLaunchConfig({
    profiles: { fixture: { harness: "codex", ...profile } },
  });
const approval = (profile: object) =>
  launchWarnings(config(profile)).some((w) => w.code === "codex_approval");

test("legacy legal profiles warn without mutation; schema errors still reject", () => {
  const old = config();
  const before = JSON.stringify(old);
  expect(launchWarnings(old).map((w) => w.code)).toEqual([
    "codex_approval",
    "codex_context_window",
    "codex_screen",
  ]);
  expect(JSON.stringify(old)).toBe(before);
  expect(() => config({ permission_mode: "bypassPermissions" })).toThrow();
  expect(
    launchWarnings(
      parseLaunchConfig({
        profiles: { pi: { harness: "pi" }, claude: { harness: "claude-code" } },
      }),
    ),
  ).toEqual([]);
});
test.each([
  { args: ["--yolo"] },
  { args: ["--dangerously-bypass-approvals-and-sandbox"] },
  { args: ["-a", "never", "-s", "read-only"] },
  { args: ["--ask-for-approval=never", "--sandbox=workspace-write"] },
  { args: ["-anever"] },
  { config: { approval_policy: "never", sandbox_mode: "workspace-write" } },
  { args: ["-c", 'approval_policy="never"'] },
  { args: ["--config=approval_policy='never'"] },
])(
  "equivalent explicit unattended settings suppress only approval warning: %j",
  (profile) => {
    expect(approval(profile)).toBe(false);
  },
);
test("direct flags outrank config; repeated config overrides use the last value", () => {
  expect(
    approval({
      config: { approval_policy: "never" },
      args: ["-a", "on-request"],
    }),
  ).toBe(true);
  expect(
    approval({ args: ["-a", "on-request", "-c", 'approval_policy="never"'] }),
  ).toBe(true);
  expect(
    approval({
      config: { approval_policy: "on-request" },
      args: ["-a", "never"],
    }),
  ).toBe(false);
  expect(
    approval({
      config: { approval_policy: "never" },
      args: ["-c", 'approval_policy="on-request"'],
    }),
  ).toBe(true);
  expect(
    approval({
      args: [
        "-c",
        'approval_policy="on-request"',
        "-c",
        'approval_policy="never"',
      ],
    }),
  ).toBe(false);
  expect(approval({ args: ["--full-auto"] })).toBe(true);
  expect(approval({ args: ["--", "--yolo"] })).toBe(true);
});
test("warnings reveal no config/env/secret values and never invent a context limit", () => {
  const c = config({
    config: { approval_policy: "synthetic-secret", model_context_window: -1 },
    args: ["--remote", "synthetic-secret"],
  });
  const output: string[] = [];
  reportLaunchWarnings(c, (line) => output.push(line));
  expect(output).toHaveLength(3);
  expect(output.join("\n")).not.toContain("synthetic-secret");
  expect(
    launchWarnings(
      config({
        config: { model_context_window: 1000000 },
        args: ["--yolo", "--no-alt-screen"],
      }),
    ),
  ).toEqual([]);
  expect(
    launchWarnings(
      config({
        args: ["--yolo", "--no-alt-screen", "-cmodel_context_window=500000"],
      }),
    ),
  ).toEqual([]);
});

test("malformed scalar quoting and string context windows cannot silence warnings", () => {
  expect(approval({ args: ["-c", "approval_policy=\"never'"] })).toBe(true);
  expect(
    launchWarnings(
      config({ config: { model_context_window: "1000000" } }),
    ).some((w) => w.code === "codex_context_window"),
  ).toBe(true);
});
