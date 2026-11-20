import type { LaunchSettingsView } from "../api.js";

/**
 * C-518: a `GET /api/launch-settings` body produced by the merged C-515 server
 * (its own synthetic test config: fake key names, fake local CLI, no network).
 * Only the temp-dir CLI path and the version hash were replaced. Extra fields
 * the page does not read (models, secret_keys, metadata.id/provider) are kept
 * on purpose to show they are ignored.
 */
export const launchSettingsServerSample = {
  version: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  profiles: [
    {
      name: "a",
      provider: "gateway",
      model_alias: "primary",
      model_id: "first",
      metadata: {
        id: "first",
        provider: "gateway",
        cost: {
          input: 1,
          output: 2,
        },
        context_window: 32000,
      },
      parameters: {
        effort: "high",
        permission_mode: null,
        auto_update: null,
        provider_flag: null,
        custom_args_count: 1,
        custom_config_count: 0,
      },
      cli: {
        path: "/opt/fixture/bin/claude",
        version: "1.2.3",
      },
      secrets: [
        {
          key: "KEY",
          set: true,
        },
      ],
      references: [],
      harness: "claude-code",
      last_check: null,
    },
    {
      name: "b",
      provider: null,
      model_alias: null,
      model_id: "standalone",
      metadata: null,
      parameters: {
        effort: null,
        permission_mode: null,
        auto_update: null,
        provider_flag: null,
        custom_args_count: 0,
        custom_config_count: 0,
      },
      cli: {
        path: null,
        version: null,
      },
      secrets: [],
      references: [],
      harness: "pi",
      last_check: null,
    },
    {
      name: "no-model",
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
      cli: {
        path: null,
        version: null,
      },
      secrets: [],
      references: [],
      harness: "pi",
      last_check: null,
    },
  ],
  providers: [
    {
      id: "gateway",
      name: "Fixture",
      base_url: "https://gateway.example.invalid",
      secret_env: {
        ANTHROPIC_API_KEY: "KEY",
      },
    },
  ],
  models: {
    primary: {
      id: "first",
      provider: "gateway",
      cost: {
        input: 1,
        output: 2,
      },
      context_window: 32000,
    },
  },
  secret_keys: ["KEY", "OTHER"],
} as unknown as LaunchSettingsView;
