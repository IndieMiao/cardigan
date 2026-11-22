import {
  ApiError,
  type CardiganClient,
  type FeishuSecretKey,
  type FeishuSettingsChange,
  type FeishuSettingsView,
  type FeishuTestResult,
} from "../api.js";

/**
 * C-561: a synthetic stand-in for the C-558 Feishu settings endpoints (tests and
 * the screenshot fixture). No file, credential or outside service is touched:
 * credential values are only checked for presence and then dropped.
 */
export function syntheticFeishuView(): FeishuSettingsView {
  return {
    version: "a".repeat(64),
    settings: {
      enabled: true,
      workbench_url: "https://workbench.example.test",
      "quiet_hours.enabled": true,
      "quiet_hours.timezone": "Asia/Shanghai",
      "quiet_hours.start": "22:00",
      "quiet_hours.end": "08:00",
      "policy.max_per_minute": 10,
      "policy.timeout_ms": 10000,
      "policy.max_attempts": 3,
      "policy.retry_delays_ms": [30000, 60000],
      "policy.title_limit": 120,
      "policy.digest_limit": 20,
      "channels.lark.enabled": true,
      "channels.lark_app.enabled": true,
      "channels.lark.max_per_minute": 20,
      "channels.lark_app.max_per_minute": 10,
      "channels.lark_app.binding_ttl_ms": 300000,
      "channels.lark_app.action_ttl_ms": 86400000,
      "channels.lark_app.binding_attempts_per_minute": 30,
      "channels.lark_app.pending_limit": 32,
      "filter.decision": true,
      "filter.human_action": true,
      "filter.merge_confirmation": true,
      "filter.notice": false,
      "filter.excluded_projects": [],
    },
    secrets: {
      lark_webhook: { set: true, updated_at: "2025-12-30T02:15:00Z" },
      lark_sign_secret: { set: false, updated_at: null },
      app_id: { set: true, updated_at: "2025-12-20T09:40:00Z" },
      app_secret: { set: true, updated_at: "2025-12-20T09:40:00Z" },
      tenant_key: { set: true, updated_at: "2025-12-20T09:40:00Z" },
    },
  };
}

export interface FakeFeishuOptions {
  /** Confirmations fail with this error (proved not written unless uncertain). */
  confirmError?: () => ApiError | undefined;
  /** Test sends answer this (or throw it). */
  test?: (
    channel: "lark" | "lark_app",
  ) => FeishuTestResult | ApiError | Promise<FeishuTestResult>;
  now?: () => string;
}

export function fakeFeishuSettings(
  initial: FeishuSettingsView = syntheticFeishuView(),
  options: FakeFeishuOptions = {},
) {
  let view = initial;
  let generation = 0;
  const previews = new Map<
    string,
    { version: string; change: FeishuSettingsChange }
  >();
  const applied = new Set<string>();
  const sentKeys = new Map<string, FeishuTestResult>();
  const log = {
    previews: [] as FeishuSettingsChange[],
    confirms: [] as {
      key: string;
      secretKeys: string[];
    }[],
    tests: [] as { channel: string; key: string }[],
    /** Distinct test messages that would have been sent. */
    sent: 0,
  };
  const client: Required<
    Pick<
      CardiganClient,
      | "feishuSettings"
      | "previewFeishuSettings"
      | "confirmFeishuSettings"
      | "testFeishuChannel"
    >
  > = {
    feishuSettings: async () => view,
    previewFeishuSettings: async (version, change) => {
      log.previews.push(change);
      if (version !== view.version)
        throw new ApiError(409, "stale_snapshot", "飞书配置已变化，请重新预览");
      const id = crypto.randomUUID();
      previews.set(id, { version, change });
      const s = view.settings;
      return {
        version,
        preview_id: id,
        restart_required: false,
        diff: [
          ...Object.entries(change.settings ?? {}).map(([key, after]) => ({
            key,
            before: s[key],
            after,
          })),
          ...[
            ...(change.secrets?.set ?? []),
            ...(change.secrets?.clear ?? []),
          ].map((k) => ({
            key: `secrets.${k}`,
            before: view.secrets[k].set ? "set" : "unset",
            after: change.secrets?.set.includes(k) ? "new" : "unset",
          })),
        ],
      };
    },
    confirmFeishuSettings: async (version, previewId, key, secrets) => {
      log.confirms.push({ key, secretKeys: Object.keys(secrets ?? {}) });
      if (applied.has(key)) return;
      const failure = options.confirmError?.();
      if (failure) throw failure;
      const p = previews.get(previewId);
      if (!p || p.version !== version || version !== view.version)
        throw new ApiError(409, "stale_snapshot", "飞书配置已变化，请重新预览");
      const set = [...(p.change.secrets?.set ?? [])].sort();
      if (
        Object.keys(secrets ?? {})
          .sort()
          .join() !== set.join()
      )
        throw new ApiError(400, "invalid_settings", "飞书配置或凭据无效");
      const at = options.now?.() ?? new Date().toISOString();
      const next = { ...view.secrets } as Record<
        FeishuSecretKey,
        { set: boolean; updated_at: string | null }
      >;
      for (const k of p.change.secrets?.set ?? [])
        next[k] = { set: true, updated_at: at };
      for (const k of p.change.secrets?.clear ?? [])
        next[k] = { set: false, updated_at: at };
      generation++;
      view = {
        version: String(generation).padStart(64, "b"),
        settings: { ...view.settings, ...p.change.settings },
        secrets: next,
      };
      applied.add(key);
      previews.delete(previewId);
    },
    testFeishuChannel: async (channel, key) => {
      log.tests.push({ channel, key });
      const replay = sentKeys.get(key);
      if (replay) return replay;
      const answer = options.test?.(channel) ?? "sent";
      if (answer instanceof ApiError) throw answer;
      const result = await answer;
      log.sent++;
      sentKeys.set(key, result);
      return result;
    },
  };
  return {
    client,
    log,
    get view() {
      return view;
    },
    /** Someone else saved meanwhile: the next confirmation is stale. */
    changeElsewhere(settings: Record<string, unknown>) {
      generation++;
      view = {
        ...view,
        version: String(generation).padStart(64, "c"),
        settings: { ...view.settings, ...settings },
      };
    },
  };
}
