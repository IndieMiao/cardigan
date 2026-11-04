import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  importClaudeSettings,
  LaunchConfigError,
  parseLaunchConfig,
  parseSecretsText,
} from "./index.js";

const fictionalSettings = {
  env: {
    ANTHROPIC_BASE_URL: "https://gateway.example.invalid",
    ANTHROPIC_AUTH_TOKEN: "sk-fictional-import-token",
    ANTHROPIC_MODEL: "opus",
    SOME_API_KEY: "sk-fictional-import-key",
  },
  permissions: { defaultMode: "acceptEdits" },
};

const existingYaml = [
  "# hand written comment that must survive",
  "providers:",
  "  keep-me:",
  "    harness: pi",
  "profiles:",
  "  pi-plain:",
  "    harness: pi",
  "",
].join("\n");

describe("importClaudeSettings", () => {
  test("splits secrets from plain env", () => {
    const result = importClaudeSettings({
      settings: fictionalSettings,
      providerName: "imported",
    });

    expect(result.envKeys).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"]);
    expect(result.secretKeys).toEqual(["ANTHROPIC_AUTH_TOKEN", "SOME_API_KEY"]);
    expect(result.provider).toEqual({
      harness: "claude-code",
      env: {
        ANTHROPIC_BASE_URL: "https://gateway.example.invalid",
        ANTHROPIC_MODEL: "opus",
      },
      secret_env: {
        ANTHROPIC_AUTH_TOKEN: "ANTHROPIC_AUTH_TOKEN",
        SOME_API_KEY: "SOME_API_KEY",
      },
    });
  });

  test("writes secrets to secrets.env and nothing else", () => {
    const result = importClaudeSettings({
      settings: fictionalSettings,
      providerName: "imported",
    });

    const secrets = parseSecretsText(result.secretsEnv);
    expect(secrets).toEqual({
      ANTHROPIC_AUTH_TOKEN: "sk-fictional-import-token",
      SOME_API_KEY: "sk-fictional-import-key",
    });
    expect(result.launchYaml).not.toContain("sk-fictional");
  });

  test("produces a launch.yaml that validates and keeps other entries", () => {
    const result = importClaudeSettings({
      settings: fictionalSettings,
      providerName: "imported",
      launchYaml: existingYaml,
    });

    const config = parseLaunchConfig(parseYaml(result.launchYaml));
    expect(Object.keys(config.providers).sort()).toEqual([
      "imported",
      "keep-me",
    ]);
    expect(config.profiles["pi-plain"]?.harness).toBe("pi");
    expect(config.providers.imported?.harness).toBe("claude-code");
    expect(result.launchYaml).toContain("# hand written comment");
  });

  test("keeps unrelated secrets.env lines and comments", () => {
    const result = importClaudeSettings({
      settings: fictionalSettings,
      providerName: "imported",
      secretsEnv: [
        "# my secrets",
        "OTHER_TOOL_KEY=value-keep-me",
        "ANTHROPIC_AUTH_TOKEN=old-value",
        "",
      ].join("\n"),
    });

    const secrets = parseSecretsText(result.secretsEnv);
    expect(secrets.OTHER_TOOL_KEY).toBe("value-keep-me");
    expect(secrets.ANTHROPIC_AUTH_TOKEN).toBe("sk-fictional-import-token");
    expect(result.secretsEnv).toContain("# my secrets");
  });

  test("quotes values that are not plain text", () => {
    const result = importClaudeSettings({
      settings: { env: { MY_API_KEY: "has spaces and #hash" } },
      providerName: "p",
    });
    expect(result.secretsEnv).toContain('MY_API_KEY="has spaces and #hash"');
    expect(parseSecretsText(result.secretsEnv).MY_API_KEY).toBe(
      "has spaces and #hash",
    );
  });

  test("refuses to overwrite an existing provider", () => {
    const result = importClaudeSettings({
      settings: fictionalSettings,
      providerName: "dup",
    });
    expect(() =>
      importClaudeSettings({
        settings: fictionalSettings,
        providerName: "dup",
        launchYaml: result.launchYaml,
      }),
    ).toThrow(/已经存在/);
  });

  test("refuses a settings file without env", () => {
    expect(() =>
      importClaudeSettings({
        settings: { permissions: {} },
        providerName: "p",
      }),
    ).toThrow(/没有 env/);
  });

  test("refuses an invalid provider name", () => {
    expect(() =>
      importClaudeSettings({
        settings: fictionalSettings,
        providerName: "Bad",
      }),
    ).toThrow(LaunchConfigError);
  });

  test("refuses a value it cannot round-trip and names only the variable", () => {
    try {
      importClaudeSettings({
        settings: { env: { MY_TOKEN: 'value-with-"quote' } },
        providerName: "p",
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      const failure = error as LaunchConfigError;
      expect(failure.code).toBe("invalid_import");
      expect(failure.message).toContain("MY_TOKEN");
      expect(JSON.stringify(failure.message)).not.toContain("value-with");
    }
  });
});
