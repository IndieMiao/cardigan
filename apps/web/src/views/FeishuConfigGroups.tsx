import { useId } from "react";
import type {
  FeishuChannel,
  FeishuSecretKey,
  FeishuSettingsView,
  ProjectSummary,
} from "../api.js";
import { formatTime, StatusTag } from "../components/Foundation.js";
import {
  SettingsGroup,
  SettingsRow,
  SettingsValue,
} from "../components/layout/SettingsLayout.js";
import { Tooltip } from "../components/Tooltip.js";
import { Button } from "../components/ui/button.js";
import {
  excludedFrom,
  formatValue,
  PUSH_LABELS,
  SECRET_LABELS,
} from "./feishu-config.js";

/** Status group rows that come from the configuration (before the binding row). */
export function FeishuStatusRows({ config }: { config: FeishuSettingsView }) {
  const on = config.settings.enabled === true;
  return (
    <SettingsRow
      label="消息推送"
      status={
        <StatusTag
          status={on ? "done" : "pending"}
          label={on ? "已开启" : "已关闭"}
        />
      }
    />
  );
}

function Value({
  config,
  label,
  setting,
  help,
  description,
}: {
  config: FeishuSettingsView;
  label: string;
  setting: string;
  help?: string;
  description?: string;
}) {
  return (
    <SettingsRow label={label} help={help} description={description}>
      <SettingsValue>
        {formatValue(setting, config.settings[setting])}
      </SettingsValue>
    </SettingsRow>
  );
}

function Secret({
  config,
  name,
}: {
  config: FeishuSettingsView;
  name: FeishuSecretKey;
}) {
  const state = config.secrets[name];
  return (
    <SettingsRow
      label={SECRET_LABELS[name]}
      status={
        <StatusTag
          status={state.set ? "done" : "pending"}
          label={state.set ? "已设置" : "未设置"}
        />
      }
    >
      {state.updated_at && (
        <SettingsValue>{formatTime(state.updated_at)}</SettingsValue>
      )}
    </SettingsRow>
  );
}

/** One channel's test message: the latest result and the send button. */
export interface FeishuTestState {
  readonly pending: boolean;
  readonly outcome?: { readonly status: string; readonly label: string };
}

function TestRow({
  label,
  state,
  unavailable,
  onSend,
}: {
  label: string;
  state: FeishuTestState | undefined;
  /** Why the test cannot be sent now; the button stays disabled. */
  unavailable: string | undefined;
  onSend: () => void;
}) {
  const labelId = useId(),
    buttonId = useId();
  const pending = state?.pending === true;
  return (
    <SettingsRow
      label={label}
      labelId={labelId}
      status={
        state?.outcome && (
          <StatusTag
            status={state.outcome.status}
            label={state.outcome.label}
          />
        )
      }
    >
      {/* Unavailable stays focusable: the reason is in the shared tooltip
          for pointer and keyboard alike (V-2845). */}
      <Tooltip content={unavailable}>
        <Button
          id={buttonId}
          aria-labelledby={`${buttonId} ${labelId}`}
          aria-disabled={!!unavailable || pending}
          data-disabled={unavailable ? true : undefined}
          onClick={() => {
            if (!unavailable && !pending) onSend();
          }}
        >
          {pending ? "发送中…" : "发送测试消息"}
        </Button>
      </Tooltip>
    </SettingsRow>
  );
}

/** Channels, quiet hours, rate limits, credentials and the folded advanced group. */
/** C-580: the pushed projects by name; "全部" when none is excluded. */
function pushedProjects(
  config: FeishuSettingsView,
  projects: readonly ProjectSummary[] | undefined,
) {
  const excluded = excludedFrom(config);
  if (!projects)
    return excluded.length ? `除 ${excluded.join("、")} 外全部` : "全部";
  const pushed = projects.filter((p) => !excluded.includes(p.id));
  if (pushed.length === projects.length) return "全部";
  return pushed.length ? pushed.map((p) => p.name).join("、") : "无";
}

export function FeishuConfigGroups({
  config,
  bound,
  tests,
  onTest,
  projects,
}: {
  config: FeishuSettingsView;
  /** C-580: names for the pushed projects (undefined while reading). */
  projects: readonly ProjectSummary[] | undefined;
  /** Whether this person has bound the app's private chat. */
  bound: boolean | undefined;
  tests: Partial<Record<FeishuChannel, FeishuTestState>>;
  onTest: (channel: FeishuChannel) => void;
}) {
  const s = config.settings;
  const off = (channel: FeishuChannel) =>
    s.enabled !== true
      ? "消息推送未开启"
      : s[`channels.${channel}.enabled`] !== true
        ? channel === "lark"
          ? "群机器人未开启"
          : "应用机器人未开启"
        : undefined;
  return (
    <>
      <SettingsGroup title="渠道">
        <Value
          config={config}
          label="群机器人"
          setting="channels.lark.enabled"
        />
        <Value
          config={config}
          label="应用机器人"
          setting="channels.lark_app.enabled"
        />
        <Value config={config} label="Workbench 链接" setting="workbench_url" />
        <TestRow
          label="群机器人测试"
          state={tests.lark}
          unavailable={off("lark")}
          onSend={() => onTest("lark")}
        />
        <TestRow
          label="应用私聊测试"
          state={tests.lark_app}
          unavailable={
            off("lark_app") ?? (bound === false ? "本人尚未绑定" : undefined)
          }
          onSend={() => onTest("lark_app")}
        />
      </SettingsGroup>
      <SettingsGroup title="推送哪些消息">
        {(
          [
            ["push_decision", "filter.decision"],
            ["push_human_action", "filter.human_action"],
            ["push_merge_confirmation", "filter.merge_confirmation"],
            ["push_notice", "filter.notice"],
          ] as const
        ).map(([kind, setting]) => (
          <Value
            key={kind}
            config={config}
            label={PUSH_LABELS[kind].label}
            description={PUSH_LABELS[kind].description}
            setting={setting}
          />
        ))}
        <SettingsRow label="项目">
          <SettingsValue>{pushedProjects(config, projects)}</SettingsValue>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="免打扰">
        <Value config={config} label="免打扰" setting="quiet_hours.enabled" />
        <SettingsRow label="时段">
          <SettingsValue>
            {`${formatValue("quiet_hours.start", s["quiet_hours.start"])}–${formatValue("quiet_hours.end", s["quiet_hours.end"])}`}
          </SettingsValue>
        </SettingsRow>
        <Value config={config} label="时区" setting="quiet_hours.timezone" />
      </SettingsGroup>
      <SettingsGroup title="限速">
        <Value
          config={config}
          label="群机器人"
          setting="channels.lark.max_per_minute"
        />
        <Value
          config={config}
          label="应用机器人"
          setting="channels.lark_app.max_per_minute"
        />
      </SettingsGroup>
      <SettingsGroup title="凭据">
        <Secret config={config} name="lark_webhook" />
        <Secret config={config} name="lark_sign_secret" />
        <Secret config={config} name="app_id" />
        <Secret config={config} name="app_secret" />
        <Secret config={config} name="tenant_key" />
      </SettingsGroup>
      <SettingsGroup title="高级" collapsible>
        <Value config={config} label="请求超时" setting="policy.timeout_ms" />
        <Value
          config={config}
          label="重试间隔"
          setting="policy.retry_delays_ms"
        />
        <Value
          config={config}
          label="发送次数上限"
          setting="policy.max_attempts"
          help="等于重试间隔的个数加 1。在“编辑配置 → 高级 → 重试间隔”中修改。"
        />
        <Value config={config} label="标题长度" setting="policy.title_limit" />
        <Value config={config} label="汇总条数" setting="policy.digest_limit" />
        <Value
          config={config}
          label="绑定码有效期"
          setting="channels.lark_app.binding_ttl_ms"
        />
        <Value
          config={config}
          label="按钮有效期"
          setting="channels.lark_app.action_ttl_ms"
        />
        <Value
          config={config}
          label="每分钟绑定尝试"
          setting="channels.lark_app.binding_attempts_per_minute"
        />
        <Value
          config={config}
          label="待处理上限"
          setting="channels.lark_app.pending_limit"
        />
      </SettingsGroup>
    </>
  );
}
