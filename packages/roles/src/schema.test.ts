import { describe, expect, test } from "vitest";
import {
  LaunchConfigError,
  parseLaunchConfig,
  parseSecretsText,
  requiredSecretKeys,
  resolveProfile,
} from "./index.js";

const fictionalConfig = {
  providers: {
    of: {
      harness: "claude-code",
      env: { ANTHROPIC_BASE_URL: "https://of.example.invalid" },
      secret_env: { ANTHROPIC_AUTH_TOKEN: "OF_AUTH_TOKEN" },
    },
    ds: {
      harness: "pi",
      env: { DS_REGION: "eu" },
      secret_env: { DS_API_KEY: "DS_API_KEY" },
    },
    cx: {
      harness: "codex",
      env: { OPENAI_BASE_URL: "https://cx.example.invalid/v1" },
      secret_env: { OPENAI_API_KEY: "CX_API_KEY" },
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
    "codex-yolo": {
      harness: "codex",
      provider: "cx",
      model: "gpt-6-astra",
      config: { model_reasoning_effort: "low", features_web_search: false },
      args: ["--yolo", "--no-alt-screen"],
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
} as const;

/**
 * Run `fn` and return the error message plus details, so assertions can check
 * the hint text as well as the headline.
 */
function errorText(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const failure = error as LaunchConfigError;
    return [failure.message, ...failure.details].join(" | ");
  }
  throw new Error("expected a LaunchConfigError");
}

describe("parseLaunchConfig", () => {
  test("accepts a config with three harnesses", () => {
    const config = parseLaunchConfig(fictionalConfig);
    expect(Object.keys(config.profiles)).toEqual([
      "claude-of",
      "codex-yolo",
      "pi-deepseek",
      "pi-plain",
    ]);
    expect(config.providers.of?.secret_env.ANTHROPIC_AUTH_TOKEN).toBe(
      "OF_AUTH_TOKEN",
    );
  });

  test("fills in empty env maps", () => {
    const config = parseLaunchConfig({
      providers: { bare: { harness: "pi" } },
      profiles: { p: { harness: "pi", provider: "bare" } },
    });
    expect(config.providers.bare?.env).toEqual({});
    expect(config.providers.bare?.secret_env).toEqual({});
  });

  test("rejects unknown top-level keys", () => {
    expect(() => parseLaunchConfig({ ...fictionalConfig, extra: 1 })).toThrow(
      LaunchConfigError,
    );
  });

  test("rejects an unknown harness", () => {
    expect(() =>
      parseLaunchConfig({ profiles: { p: { harness: "cursor" } } }),
    ).toThrow(LaunchConfigError);
  });

  test("rejects a profile pointing at a missing provider", () => {
    expect(
      errorText(() =>
        parseLaunchConfig({
          providers: {},
          profiles: { p: { harness: "pi", provider: "nope" } },
        }),
      ),
    ).toMatch(/不存在的接入点 nope/);
  });

  test("rejects a provider whose harness differs from the profile", () => {
    expect(
      errorText(() =>
        parseLaunchConfig({
          providers: { of: { harness: "claude-code" } },
          profiles: { p: { harness: "pi", provider: "of" } },
        }),
      ),
    ).toMatch(/harness 是 pi，但接入点 of 是 claude-code/);
  });

  test("rejects harness-specific fields on the wrong harness", () => {
    const cases = [
      { harness: "claude-code", config: { a: "b" } },
      { harness: "codex", permission_mode: "acceptEdits" },
      { harness: "codex", auto_update: false },
      { harness: "claude-code", provider_flag: "deepseek" },
      { harness: "claude-code", agent_dir: "/srv/x" },
    ];
    for (const profile of cases) {
      expect(() =>
        parseLaunchConfig({ providers: {}, profiles: { p: profile } }),
      ).toThrow(LaunchConfigError);
    }
  });

  test("rejects a variable that is both plain and secret", () => {
    expect(
      errorText(() =>
        parseLaunchConfig({
          providers: {
            p: { harness: "pi", env: { K: "v" }, secret_env: { K: "K" } },
          },
        }),
      ),
    ).toMatch(/既在 env 又在 secret_env/);
  });

  test("rejects an invalid provider name", () => {
    expect(() =>
      parseLaunchConfig({ providers: { "Bad Name": { harness: "pi" } } }),
    ).toThrow(LaunchConfigError);
  });
});

describe("resolveProfile and requiredSecretKeys", () => {
  const config = parseLaunchConfig(fictionalConfig);

  test("returns the provider definition", () => {
    const resolved = resolveProfile(config, "codex-yolo");
    expect(resolved.provider?.name).toBe("cx");
    expect(resolved.profile.model).toBe("gpt-6-astra");
  });

  test("works without a provider", () => {
    expect(resolveProfile(config, "pi-plain").provider).toBeUndefined();
  });

  test("names the missing profile and lists the known ones", () => {
    try {
      resolveProfile(config, "nope");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LaunchConfigError);
      expect((error as LaunchConfigError).code).toBe("unknown_profile");
      expect((error as LaunchConfigError).details).toContain("claude-of");
    }
  });

  test("lists secret keys without values", () => {
    expect(requiredSecretKeys(config, "claude-of")).toEqual(["OF_AUTH_TOKEN"]);
    expect(requiredSecretKeys(config, "pi-plain")).toEqual([]);
  });
});

describe("parseSecretsText", () => {
  test("parses comments, blanks, quotes and duplicates", () => {
    const text = [
      "# fictional test secrets",
      "",
      "OF_AUTH_TOKEN=sk-test-not-real",
      'SPACED = "value with spaces"',
      "QUOTED='single'",
      "OF_AUTH_TOKEN=sk-test-second",
      "",
    ].join("\n");
    expect(parseSecretsText(text)).toEqual({
      OF_AUTH_TOKEN: "sk-test-second",
      SPACED: "value with spaces",
      QUOTED: "single",
    });
  });

  test("keeps every value that has no comment or blank", () => {
    expect(parseSecretsText("A=1\nB=2\n")).toEqual({ A: "1", B: "2" });
  });

  test("rejects a line that is not KEY=VALUE", () => {
    expect(errorText(() => parseSecretsText("A=1\nnonsense\n"))).toMatch(
      /第 2 行/,
    );
  });

  test("rejects an invalid variable name", () => {
    expect(errorText(() => parseSecretsText("1BAD=x\n"))).toMatch(
      /非法的变量名/,
    );
  });
});

describe("C-213 explicit upstream configuration", () => {
  test("defaults only the approved v3 rules and never infers endpoints from credential environments", () => {
    const config = parseLaunchConfig({
      ...fictionalConfig,
      upstream_health: {},
    });
    expect(config.upstream_health).toEqual({
      inactive_session_count: 3,
      inactivity_window_ms: 600_000,
      recurrence_window_ms: 900_000,
    });
    expect(config.providers.of?.upstream).toBeUndefined();
  });
  test.each([
    "https://user:secret@example.invalid",
    "https://example.invalid/token",
    "https://example.invalid?token=secret",
    "https://example.invalid#secret",
    "ftp://example.invalid",
  ])("rejects a credential-bearing or unsupported probe origin: %s", (url) => {
    const error = errorText(() =>
      parseLaunchConfig({
        providers: {
          relay: {
            harness: "codex",
            upstream: { group: "relay", probe_url: url },
          },
        },
      }),
    );
    expect(error).toContain("probe_url");
    expect(error).not.toContain("secret");
  });
  test.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])(
    "rejects unsupported timing %s without a fallback",
    (n) => {
      expect(() =>
        parseLaunchConfig({
          upstream_health: {
            probe: { interval_ms: n, timeout_ms: 100, stale_after_ms: 200 },
          },
        }),
      ).toThrow();
    },
  );
  test("requires all explicit probe timings and validates v3 thresholds", () => {
    expect(() =>
      parseLaunchConfig({ upstream_health: { probe: { interval_ms: 1000 } } }),
    ).toThrow();
    for (const key of [
      "inactive_session_count",
      "inactivity_window_ms",
      "recurrence_window_ms",
    ])
      expect(() =>
        parseLaunchConfig({ upstream_health: { [key]: 0 } }),
      ).toThrow();
    const config = parseLaunchConfig({
      providers: {
        a: {
          harness: "codex",
          upstream: {
            group: "relay",
            probe_url: "https://gateway.example.invalid",
          },
        },
      },
      upstream_health: {
        probe: { interval_ms: 1000, timeout_ms: 100, stale_after_ms: 2000 },
      },
    });
    expect(config.providers.a?.upstream?.group).toBe("relay");
  });
});
