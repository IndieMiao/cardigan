import { expect, test } from "vitest";
import { compileLaunch } from "./compile.js";
import { parseLaunchConfig, resolveProfile } from "./schema.js";
import {
  compiledLaunchSettings,
  effortFromArgs,
  profileLaunchSettings,
} from "./settings.js";

test("C-106: Claude Code effort is the last --effort the CLI receives", () => {
  expect(effortFromArgs("claude-code", ["--effort", "low"])).toBe("low");
  expect(effortFromArgs("claude-code", ["--effort=xhigh"])).toBe("xhigh");
  expect(
    effortFromArgs("claude-code", ["--effort", "low", "--effort", "high"]),
  ).toBe("high");
  // A flag without a readable value makes it unknown, not the earlier value.
  expect(effortFromArgs("claude-code", ["--effort", "low", "--effort"])).toBe(
    undefined,
  );
  expect(effortFromArgs("claude-code", ["--model", "opus"])).toBe(undefined);
  // Positional arguments after `--` are not options.
  expect(
    effortFromArgs("claude-code", ["--effort", "low", "--", "--effort", "x"]),
  ).toBe("low");
});

test("C-106: Codex effort honours later -c/--config overrides", () => {
  const key = "model_reasoning_effort";
  expect(effortFromArgs("codex", ["-c", `${key}="high"`])).toBe("high");
  expect(
    effortFromArgs("codex", ["-c", `${key}="high"`, "-c", `${key}="low"`]),
  ).toBe("low");
  expect(
    effortFromArgs("codex", ["-c", `${key}="high"`, `--config=${key}=minimal`]),
  ).toBe("minimal");
  expect(effortFromArgs("codex", ["--config", `${key}='medium'`])).toBe(
    "medium",
  );
  // An override that cannot be read makes the effort unknown.
  expect(
    effortFromArgs("codex", ["-c", `${key}="high"`, "-c", `${key}={a=1}`]),
  ).toBe(undefined);
  // Other overrides do not matter; no override at all is unknown (config.toml).
  expect(effortFromArgs("codex", ["-c", `${key}="high"`, "-c", "x=1"])).toBe(
    "high",
  );
  expect(effortFromArgs("codex", ["-m", "gpt"])).toBe(undefined);
});

test("C-106: Pi has no structured effort", () => {
  expect(effortFromArgs("pi", ["--effort", "high"])).toBe(undefined);
});

test("C-106: profile settings match what the compiled launch passes", () => {
  const config = parseLaunchConfig({
    profiles: {
      coder: {
        harness: "codex",
        model: "gpt-x",
        config: { model_reasoning_effort: "high" },
        args: ["-c", 'model_reasoning_effort="low"'],
      },
      claude: {
        harness: "claude-code",
        model: "opus",
        args: ["--effort", "xhigh"],
      },
      pi: { harness: "pi", model: "m" },
    },
  });
  for (const name of ["coder", "claude", "pi"]) {
    const resolved = resolveProfile(config, name);
    const compiled = compileLaunch({
      config,
      profile: name,
      secrets: {},
      runtimeDir: "/tmp/run",
    });
    expect(profileLaunchSettings(resolved.profile)).toEqual(
      compiledLaunchSettings(compiled.harness, compiled.args),
    );
  }
  expect(
    profileLaunchSettings(resolveProfile(config, "coder").profile),
  ).toEqual({ harness: "codex", effort: "low" });
  expect(
    profileLaunchSettings(resolveProfile(config, "claude").profile),
  ).toEqual({ harness: "claude-code", effort: "xhigh" });
  expect(profileLaunchSettings(resolveProfile(config, "pi").profile)).toEqual({
    harness: "pi",
  });
});
