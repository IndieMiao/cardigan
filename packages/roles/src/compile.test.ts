import { describe, expect, test } from "vitest";
import {
  compileLaunch,
  LaunchConfigError,
  parseLaunchConfig,
  REDACTED,
  redactLaunch,
} from "./index.js";

const runtimeDir = "/run/cardigan-fake";

const config = parseLaunchConfig({
  providers: {
    of: {
      harness: "claude-code",
      env: { ANTHROPIC_BASE_URL: "https://of.example.invalid" },
      secret_env: {
        ANTHROPIC_AUTH_TOKEN: "OF_AUTH_TOKEN",
        ANTHROPIC_API_KEY: "OF_API_KEY",
      },
    },
    cx: {
      harness: "codex",
      env: { OPENAI_BASE_URL: "https://cx.example.invalid/v1" },
      secret_env: { OPENAI_API_KEY: "CX_API_KEY" },
    },
    ds: {
      harness: "pi",
      env: {},
      secret_env: { DS_API_KEY: "DS_API_KEY" },
    },
  },
  profiles: {
    "claude-of": {
      harness: "claude-code",
      provider: "of",
      model: "opus",
      permission_mode: "bypassPermissions",
      auto_update: false,
      args: ["--effort", "low"],
    },
    "claude-of-updating": {
      harness: "claude-code",
      provider: "of",
      auto_update: true,
    },
    "codex-yolo": {
      harness: "codex",
      provider: "cx",
      model: "gpt-6-astra",
      config: { model_reasoning_effort: "low", features_web_search: false },
      args: ["--yolo"],
    },
    "pi-deepseek": {
      harness: "pi",
      provider: "ds",
      provider_flag: "deepseek",
      model: "deepseek-flash",
      agent_dir: "/srv/cardigan/pi-home",
      args: ["--thinking", "off"],
    },
    "pi-plain": { harness: "pi" },
  },
});

const secrets = {
  OF_AUTH_TOKEN: "sk-fictional-of-token",
  OF_API_KEY: "sk-fictional-of-key",
  CX_API_KEY: "sk-fictional-cx-key",
  DS_API_KEY: "sk-fictional-ds-key",
};

describe("compileLaunch: claude-code", () => {
  test("writes a 0600 settings file and passes --settings", () => {
    const compiled = compileLaunch({
      config,
      profile: "claude-of",
      secrets,
      runtimeDir,
    });

    expect(compiled.command).toBe("claude");
    expect(compiled.harness).toBe("claude-code");
    expect(compiled.args).toEqual([
      "--settings",
      `${runtimeDir}/claude-of.claude-settings.json`,
      "--model",
      "opus",
      "--permission-mode",
      "bypassPermissions",
      "--effort",
      "low",
    ]);
    expect(compiled.env).toEqual({ DISABLE_AUTOUPDATER: "1" });
    expect(compiled.secretEnvKeys).toEqual([
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);

    expect(compiled.files).toHaveLength(1);
    const file = compiled.files[0];
    expect(file?.path).toBe(`${runtimeDir}/claude-of.claude-settings.json`);
    expect(file?.mode).toBe(0o600);
    expect(JSON.parse(file?.content ?? "{}")).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://of.example.invalid",
        ANTHROPIC_AUTH_TOKEN: "sk-fictional-of-token",
        ANTHROPIC_API_KEY: "sk-fictional-of-key",
      },
    });
  });

  test("keeps the auto-updater when auto_update is true or unset", () => {
    for (const profile of ["claude-of-updating", "claude-of"]) {
      const compiled = compileLaunch({
        config:
          profile === "claude-of"
            ? parseLaunchConfig({
                providers: {},
                profiles: { p: { harness: "claude-code", auto_update: true } },
              })
            : config,
        profile: profile === "claude-of" ? "p" : profile,
        secrets,
        runtimeDir,
      });
      expect(compiled.env).toEqual({});
    }
  });

  test("does not pass --permission-mode when the profile omits it", () => {
    const compiled = compileLaunch({
      config: parseLaunchConfig({
        providers: {},
        profiles: { p: { harness: "claude-code" } },
      }),
      profile: "p",
      secrets: {},
      runtimeDir,
    });
    expect(compiled.args).toEqual([
      "--settings",
      `${runtimeDir}/p.claude-settings.json`,
    ]);
  });
});

describe("compileLaunch: codex", () => {
  test("composes --profile, -m, -c and extra args", () => {
    const compiled = compileLaunch({
      config,
      profile: "codex-yolo",
      secrets,
      runtimeDir,
      extraArgs: ["exec", "do the thing"],
    });

    expect(compiled.command).toBe("codex");
    expect(compiled.args).toEqual([
      "--profile",
      "cx",
      "-m",
      "gpt-6-astra",
      "-c",
      'model_reasoning_effort="low"',
      "-c",
      "features_web_search=false",
      "--yolo",
      "exec",
      "do the thing",
    ]);
    expect(compiled.env).toEqual({
      OPENAI_BASE_URL: "https://cx.example.invalid/v1",
      OPENAI_API_KEY: "sk-fictional-cx-key",
    });
    expect(compiled.files).toEqual([]);
    expect(compiled.secretEnvKeys).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("compileLaunch: pi", () => {
  test("passes --provider, --model and PI_CODING_AGENT_DIR", () => {
    const compiled = compileLaunch({
      config,
      profile: "pi-deepseek",
      secrets,
      runtimeDir,
    });

    expect(compiled.command).toBe("pi");
    expect(compiled.args).toEqual([
      "--provider",
      "deepseek",
      "--model",
      "deepseek-flash",
      "--thinking",
      "off",
    ]);
    expect(compiled.env).toEqual({
      DS_API_KEY: "sk-fictional-ds-key",
      PI_CODING_AGENT_DIR: "/srv/cardigan/pi-home",
    });
  });

  test("a bare profile needs no provider and no secrets", () => {
    const compiled = compileLaunch({
      config,
      profile: "pi-plain",
      secrets: {},
      runtimeDir,
    });
    expect(compiled.args).toEqual([]);
    expect(compiled.env).toEqual({});
    expect(compiled.files).toEqual([]);
  });
});

describe("compileLaunch: failures", () => {
  test("names the missing secret without printing values", () => {
    try {
      compileLaunch({
        config,
        profile: "claude-of",
        secrets: { OF_AUTH_TOKEN: "sk-fictional-of-token" },
        runtimeDir,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LaunchConfigError);
      const failure = error as LaunchConfigError;
      expect(failure.code).toBe("missing_secret");
      expect(failure.details.join(" ")).toContain("OF_API_KEY");
      expect(JSON.stringify(failure.details)).not.toContain("sk-fictional");
    }
  });

  test("treats an empty secret as missing", () => {
    try {
      compileLaunch({
        config,
        profile: "pi-deepseek",
        secrets: { DS_API_KEY: "" },
        runtimeDir,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      const failure = error as LaunchConfigError;
      expect(failure.code).toBe("missing_secret");
      expect(failure.details.join(" ")).toContain("DS_API_KEY");
    }
  });

  test("rejects an unknown profile", () => {
    expect(() =>
      compileLaunch({ config, profile: "nope", secrets, runtimeDir }),
    ).toThrow(/没有名为 nope/);
  });
});

describe("redactLaunch", () => {
  test("masks secret env values and file content", () => {
    const compiled = compileLaunch({
      config,
      profile: "claude-of",
      secrets,
      runtimeDir,
    });
    const redacted = redactLaunch(compiled, secrets);
    const printable = JSON.stringify(redacted);

    expect(printable).not.toContain("sk-fictional");
    expect(redacted.files[0]?.content).toContain(REDACTED);
    expect(redacted.files[0]?.content).toContain("https://of.example.invalid");
    expect(JSON.parse(redacted.files[0]?.content ?? "{}")).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://of.example.invalid",
        ANTHROPIC_AUTH_TOKEN: REDACTED,
        ANTHROPIC_API_KEY: REDACTED,
      },
    });
  });

  test("masks secret env values for codex and pi", () => {
    for (const profile of ["codex-yolo", "pi-deepseek"]) {
      const compiled = compileLaunch({ config, profile, secrets, runtimeDir });
      const redacted = redactLaunch(compiled, secrets);
      expect(JSON.stringify(redacted)).not.toContain("sk-fictional");
      for (const key of compiled.secretEnvKeys) {
        expect(redacted.env[key]).toBe(REDACTED);
      }
    }
  });

  test("leaves non-secret values alone", () => {
    const compiled = compileLaunch({
      config,
      profile: "codex-yolo",
      secrets,
      runtimeDir,
    });
    const redacted = redactLaunch(compiled, secrets);
    expect(redacted.env.OPENAI_BASE_URL).toBe("https://cx.example.invalid/v1");
  });
});
