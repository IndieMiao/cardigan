import { describe, expect, test } from "vitest";
import {
  compileAssignmentLaunch,
  compileLaunch,
  parseLaunchConfig,
  resolveProfile,
} from "./index.js";

// Sanitized launch shapes, not host configuration. The old side spells out the
// overrides independently of the new provider/model expansion.
const base = "https://relay.example.invalid/v1";
const claudeUrl = "https://messages.example.invalid";
const auth = { OPENAI_API_KEY: "GATEWAY_KEY" };
const oldCodex = (id: string, window: number) => ({
  harness: "codex",
  provider: "relay",
  model: id,
  config: {
    model_provider: "relay",
    "model_providers.relay.name": "Relay",
    "model_providers.relay.base_url": base,
    "model_providers.relay.wire_api": "responses",
    "model_providers.relay.env_key": "OPENAI_API_KEY",
    model_reasoning_effort: "xhigh",
    model_context_window: window,
  },
  args: ["--yolo", "--no-alt-screen"],
});
const oldClaude = (effort: string) => ({
  harness: "claude-code",
  provider: "msg",
  model: "opus-fixture[1m]",
  permission_mode: "bypassPermissions",
  args: ["--effort", effort],
});
const legacy = {
  providers: {
    relay: { harness: "codex", secret_env: auth },
    msg: {
      harness: "claude-code",
      env: { ANTHROPIC_BASE_URL: claudeUrl },
      secret_env: { ANTHROPIC_AUTH_TOKEN: "MSG_AUTH" },
    },
    ds: { harness: "pi", secret_env: { DEEPSEEK_API_KEY: "DS_KEY" } },
  },
  profiles: {
    "codex-sol": oldCodex("gpt-fixture-sol", 1000000),
    "codex-astra": oldCodex("gpt-fixture-astra", 872000),
    "claude-opus": oldClaude("medium"),
    "claude-opus-high": oldClaude("high"),
    "pi-deepseek": {
      harness: "pi",
      provider: "ds",
      provider_flag: "deepseek",
      model: "deepseek-fixture",
      args: ["--thinking", "high"],
    },
  },
};
const newCodex = (model: string) => ({
  harness: "codex",
  model,
  effort: "xhigh",
  args: ["--yolo", "--no-alt-screen"],
});
const newClaude = (effort: string) => ({
  harness: "claude-code",
  model: "opus",
  permission_mode: "bypassPermissions",
  effort,
});
const modern = {
  providers: {
    relay: {
      ...legacy.providers.relay,
      api: "openai-responses",
      base_url: base,
      codex: { profile: "relay", name: "Relay", env_key: "OPENAI_API_KEY" },
    },
    msg: {
      harness: "claude-code",
      base_url: claudeUrl,
      secret_env: legacy.providers.msg.secret_env,
    },
    ds: legacy.providers.ds,
  },
  models: {
    sol: { id: "gpt-fixture-sol", provider: "relay", context_window: 1000000 },
    astra: {
      id: "gpt-fixture-astra",
      provider: "relay",
      context_window: 872000,
    },
    opus: {
      id: "opus-fixture[1m]",
      provider: "msg",
      context_window: 1000000,
      reasoning_efforts: ["medium", "high"],
    },
    deep: { id: "deepseek-fixture", provider: "ds", context_window: 64000 },
  },
  profiles: {
    "codex-sol": newCodex("sol"),
    "codex-astra": newCodex("astra"),
    "claude-opus": newClaude("medium"),
    "claude-opus-high": newClaude("high"),
    "pi-deepseek": {
      harness: "pi",
      model: "deep",
      provider_flag: "deepseek",
      effort: "high",
    },
  },
};
function compile(config: unknown, profile: string) {
  return compileLaunch({
    config: parseLaunchConfig(config),
    profile,
    runtimeDir: "/fixture",
    secrets: { GATEWAY_KEY: "one", MSG_AUTH: "two", DS_KEY: "three" },
  });
}

describe("LP-1 configuration migration", () => {
  test.each(Object.keys(legacy.profiles))(
    "preserves %s's command, ordered argv, env and settings files",
    (profile) => {
      expect(compile(modern, profile)).toEqual(compile(legacy, profile));
    },
  );
  test("changing one concrete ID changes both profiles, not their names or effort", () => {
    const changed = {
      ...modern,
      models: {
        ...modern.models,
        opus: { ...modern.models.opus, id: "next-opus" },
      },
    };
    for (const profile of ["claude-opus", "claude-opus-high"]) {
      expect(compile(changed, profile).args).toEqual(
        compile(modern, profile).args.map((x) =>
          x === "opus-fixture[1m]" ? "next-opus" : x,
        ),
      );
      expect(
        resolveProfile(parseLaunchConfig(changed), profile).profile.model,
      ).toBe("next-opus");
    }
  });
  test("inline Codex endpoints need no external Codex profile", () => {
    const relay = {
      ...modern.providers.relay,
      codex: { env_key: "OPENAI_API_KEY" },
    };
    const result = compile(
      { ...modern, providers: { ...modern.providers, relay } },
      "codex-sol",
    );
    expect(result.args[0]).toBe("-m");
    expect(result.args).not.toContain("--profile");
    expect(result.args).toContain(
      'model_providers.relay.env_key="OPENAI_API_KEY"',
    );
    expect(result.env.OPENAI_API_KEY).toBe("one");
  });
  test("rejects mismatched providers, capabilities, unsupported effort and credential-bearing endpoints", () => {
    for (const override of [
      { provider: "ds" },
      { harness: "pi" },
      { effort: "unknown" },
    ]) {
      expect(() =>
        parseLaunchConfig({
          ...modern,
          profiles: { bad: { ...newClaude("high"), ...override } },
        }),
      ).toThrow();
    }
    for (const base_url of [
      "not-a-url",
      "https://user:pass@relay.invalid",
      "https://relay.invalid/?token=x",
    ]) {
      expect(() =>
        parseLaunchConfig({
          providers: { relay: { harness: "codex", base_url } },
        }),
      ).toThrow();
    }
  });
});

test("a Pi and a Codex profile can use one Responses route and secret reference", () => {
  const shared = {
    providers: {
      relay: {
        api: "openai-responses",
        base_url: base,
        base_url_env: "PI_RELAY_URL",
        secret_env: auth,
      },
    },
    models: { shared: modern.models.sol },
    profiles: {
      codex: { harness: "codex", model: "shared" },
      pi: { harness: "pi", model: "shared" },
    },
  };
  const codex = compile(shared, "codex"),
    pi = compile(shared, "pi");
  expect(codex.args).toContain(`model_providers.relay.base_url="${base}"`);
  expect(codex.args).toContain(
    'model_providers.relay.env_key="OPENAI_API_KEY"',
  );
  expect(codex.env).toEqual({ OPENAI_API_KEY: "one" });
  expect(pi.env).toMatchObject({ OPENAI_API_KEY: "one", PI_RELAY_URL: base });
  const assignment = compileAssignmentLaunch({
    assignment: {
      assignment_id: "A-1",
      run_id: "R-1",
      card_id: "C-1",
      work_item_id: "W-1",
      project_id: "fixture",
    },
    role: {
      role_id: "coder",
      harness: "pi",
      launch_profile: "pi",
      worktree: "write",
      allowed_tools: [],
    },
    launch: parseLaunchConfig(shared),
    mcp: { url: "https://fixture.invalid/mcp" },
    run_dir: "/fixture/run",
    work_dir: "/fixture/work",
    first_prompt: "fixture",
    secrets: { GATEWAY_KEY: "one" },
  });
  for (const launch of [pi, assignment]) {
    const file = launch.files.find(
      (f) => f.path === `${launch.env.PI_CODING_AGENT_DIR}/models.json`,
    );
    expect(file?.mode).toBe(0o600);
    const registry = JSON.parse(file?.content ?? "null");
    const route =
      registry.providers[
        launch.args[launch.args.indexOf("--provider") + 1] ?? ""
      ];
    expect(route).toMatchObject({
      api: "openai-responses",
      baseUrl: base,
      apiKey: "$OPENAI_API_KEY",
    });
    expect(route.models).toEqual([
      {
        id: launch.args[launch.args.indexOf("--model") + 1],
        contextWindow: 1000000,
      },
    ]);
    expect(file?.content).not.toContain('"one"');
  }
  expect(assignment.env).not.toHaveProperty("OPENAI_API_KEY");
  expect(assignment.secret_env.OPENAI_API_KEY).toBe("one");
  expect(pi.args).toEqual([
    "--provider",
    "relay",
    "--model",
    "gpt-fixture-sol",
  ]);
});

test("inline Codex validates credential ownership and refuses competing route overrides", () => {
  const input = (
    secret_env: Record<string, string>,
    codex: Record<string, unknown>,
    extra = {},
  ) => ({
    providers: {
      relay: { harness: "codex", base_url: base, secret_env, codex },
    },
    profiles: { active: { harness: "codex", provider: "relay", ...extra } },
  });
  const two = { RELAY: "GATEWAY_KEY", EXTRA: "MSG_AUTH" };
  for (const cfg of [
    input(two, {}),
    input(two, { env_key: "OTHER_ROUTE_KEY" }),
    input({}, { env_key: "RELAY" }),
    input(two, { env_key: "RELAY", requires_openai_auth: true }),
    input(
      two,
      { env_key: "RELAY" },
      { config: { "model_providers.relay.env_key": "OTHER_ROUTE_KEY" } },
    ),
    input(
      two,
      { env_key: "RELAY" },
      { args: ["-c", 'model_provider="other"'] },
    ),
  ])
    expect(() => parseLaunchConfig(cfg)).toThrow();
  expect(compile(input(two, { env_key: "RELAY" }), "active").args).toContain(
    'model_providers.relay.env_key="RELAY"',
  );
  for (const cfg of [input({}, {}), input(two, { requires_openai_auth: true })])
    expect(compile(cfg, "active").args.join(" ")).not.toContain("env_key=");
});

test.each(["relay.v1", "openai", "ollama", "lmstudio", "amazon-bedrock"])(
  "rejects unsupported inline Codex key %s without restricting external profile names",
  (name) => {
    const profiles = { p: { harness: "codex", provider: name } };
    expect(() =>
      parseLaunchConfig({
        providers: { [name]: { harness: "codex", base_url: base } },
        profiles,
      }),
    ).toThrow();
    expect(
      compile({ providers: { [name]: { harness: "codex" } }, profiles }, "p")
        .args,
    ).toEqual(["--profile", name]);
  },
);
