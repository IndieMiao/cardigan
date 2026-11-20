import type { LaunchSettingsView } from "../api.js";

/**
 * C-518 synthetic launch settings (C-515 read contract): 4 profiles, 3
 * providers, 3 role and 2 employee references. No real host, endpoint or
 * credential; secrets carry only key names and whether they are set.
 */
export const launchSettingsFixture: LaunchSettingsView = {
  version: "a".repeat(64),
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      base_url: "https://anthropic.example.test",
    },
    { id: "openai", name: "OpenAI", base_url: null },
    {
      id: "deepseek",
      name: "DeepSeek",
      base_url: "https://deepseek.example.test/v1",
    },
  ],
  profiles: [
    {
      name: "claude-opus",
      harness: "claude-code",
      provider: "anthropic",
      model_alias: "opus",
      model_id: "claude-opus-fixture-1",
      metadata: {
        cost: { input: 15, output: 75 },
        context_window: 200000,
        max_output_tokens: 32000,
        reasoning_efforts: ["low", "medium", "high"],
      },
      parameters: {
        effort: "high",
        permission_mode: "bypassPermissions",
        auto_update: false,
        provider_flag: null,
        custom_args_count: 0,
        custom_config_count: 1,
      },
      cli: { path: "/opt/fixture/bin/claude", version: "9.9.1" },
      secrets: [{ key: "ANTHROPIC_API_KEY", set: true }],
      references: [
        {
          project_id: "p-1",
          role_id: "writer",
          version: 2,
          name: "文档写手",
        },
        {
          project_id: "p-2",
          role_id: "reviewer",
          version: 3,
          name: "代码审核",
        },
        { employee_id: "E-3", name: "悟空" },
      ],
      last_check: {
        id: "00000000-0000-4000-8000-000000000001",
        version: "a".repeat(64),
        mode: "metadata",
        started_at: "2025-12-31T23:40:00.000Z",
        finished_at: "2025-12-31T23:40:02.000Z",
        status: "passed",
        problems: [],
        cli_version: "9.9.1",
      },
    },
    {
      name: "codex-sol",
      harness: "codex",
      provider: "openai",
      model_alias: null,
      model_id: "gpt-fixture-sol",
      metadata: null,
      parameters: {
        effort: "medium",
        permission_mode: null,
        auto_update: null,
        provider_flag: "openai",
        custom_args_count: 2,
        custom_config_count: 0,
      },
      cli: { path: "/opt/fixture/bin/codex", version: null },
      secrets: [
        { key: "OPENAI_API_KEY", set: false },
        { key: "OPENAI_ORG", set: true },
      ],
      references: [
        {
          project_id: "p-1",
          role_id: "coder",
          // An older version than the current coder v2 in the settings fixture.
          version: 1,
          name: "开发工程师",
        },
      ],
      last_check: {
        id: "00000000-0000-4000-8000-000000000002",
        version: "b".repeat(64),
        mode: "online",
        started_at: "2025-12-31T22:00:00.000Z",
        finished_at: "2025-12-31T22:00:05.000Z",
        status: "failed",
        problems: ["secret_missing", "model_not_listed"],
        cli_version: null,
      },
    },
    {
      name: "pi-deepseek",
      harness: "pi",
      provider: "deepseek",
      model_alias: "deepseek-chat",
      model_id: "deepseek-chat",
      metadata: { context_window: 64000 },
      parameters: {
        effort: null,
        permission_mode: null,
        auto_update: true,
        provider_flag: null,
        custom_args_count: 0,
        custom_config_count: 0,
      },
      cli: { path: null, version: null },
      secrets: [{ key: "DEEPSEEK_API_KEY", set: true }],
      references: [],
      last_check: null,
    },
    {
      name: "claude-local",
      harness: "claude-code",
      provider: null,
      model_alias: null,
      model_id: null,
      metadata: null,
      parameters: {
        effort: null,
        permission_mode: null,
        auto_update: null,
        provider_flag: null,
        custom_args_count: 0,
        custom_config_count: 0,
      },
      cli: { path: "/opt/fixture/bin/claude", version: "9.9.1" },
      secrets: [],
      references: [{ employee_id: "E-4", name: "八戒" }],
      last_check: {
        id: "00000000-0000-4000-8000-000000000003",
        version: "a".repeat(64),
        mode: "metadata",
        started_at: "2025-12-31T23:59:00.000Z",
        finished_at: null,
        status: "running",
        problems: [],
        cli_version: null,
      },
    },
  ],
};
