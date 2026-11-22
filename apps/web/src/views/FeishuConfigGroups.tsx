import { createContext, useContext } from "react";
import { formatTime, StatusTag } from "../components/Foundation.js";
import {
  SettingsGroup,
  SettingsRow,
  SettingsValue,
} from "../components/layout/SettingsLayout.js";

/** One write-only secret: whether it is set and when it last changed. */
export interface FeishuSecretState {
  set: boolean;
  updated_at?: string;
}

/**
 * Display model for the Feishu bot configuration groups (C-563 layout only).
 * No client reads or writes it yet: C-561 connects it to the server, and only
 * synthetic fixtures provide it until then, so real users never see made-up
 * values or controls that do nothing.
 */
export interface FeishuConfigView {
  enabled: boolean;
  workbench_url: string;
  channels: {
    lark: { enabled: boolean; per_minute: number };
    lark_app: { enabled: boolean; per_minute: number };
  };
  quiet_hours: {
    enabled: boolean;
    start: string;
    end: string;
    timezone: string;
  };
  secrets: {
    lark_webhook: FeishuSecretState;
    lark_sign_secret: FeishuSecretState;
    app_id: FeishuSecretState;
    app_secret: FeishuSecretState;
    tenant_key: FeishuSecretState;
  };
  advanced: {
    timeout_seconds: number;
    retry_attempts: number;
    retry_interval_seconds: number;
    title_max_chars: number;
    digest_max_items: number;
    bind_code_ttl_minutes: number;
    button_ttl_minutes: number;
    bind_attempts_per_minute: number;
    max_concurrency: number;
  };
}

export const FeishuConfigContext = createContext<FeishuConfigView | undefined>(
  undefined,
);

export function useFeishuConfig() {
  return useContext(FeishuConfigContext);
}

const onOff = (on: boolean) => (on ? "开启" : "关闭");

/** Status group rows that come from the configuration (before the binding row). */
export function FeishuStatusRows({ config }: { config: FeishuConfigView }) {
  return (
    <SettingsRow
      label="消息推送"
      status={
        <StatusTag
          status={config.enabled ? "done" : "pending"}
          label={config.enabled ? "已开启" : "已关闭"}
        />
      }
    />
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return (
    <SettingsRow label={label}>
      <SettingsValue>{value}</SettingsValue>
    </SettingsRow>
  );
}

function Secret({ label, state }: { label: string; state: FeishuSecretState }) {
  return (
    <SettingsRow
      label={label}
      status={
        <StatusTag
          status={state.set ? "done" : "pending"}
          label={state.set ? "已设置" : "未设置"}
        />
      }
    >
      {state.set && state.updated_at && (
        <SettingsValue>{formatTime(state.updated_at)}</SettingsValue>
      )}
    </SettingsRow>
  );
}

/** Channels, quiet hours, rate limits, credentials and the folded advanced group. */
export function FeishuConfigGroups({ config }: { config: FeishuConfigView }) {
  const { channels, quiet_hours: quiet, secrets, advanced } = config;
  return (
    <>
      <SettingsGroup title="渠道">
        <Value label="群机器人" value={onOff(channels.lark.enabled)} />
        <Value label="应用机器人" value={onOff(channels.lark_app.enabled)} />
        <Value label="Workbench 链接" value={config.workbench_url} />
      </SettingsGroup>
      <SettingsGroup title="免打扰">
        <Value label="免打扰" value={onOff(quiet.enabled)} />
        <Value label="时段" value={`${quiet.start}–${quiet.end}`} />
        <Value label="时区" value={quiet.timezone} />
      </SettingsGroup>
      <SettingsGroup title="限速">
        <Value
          label="群机器人"
          value={`每分钟 ${channels.lark.per_minute} 条`}
        />
        <Value
          label="应用机器人"
          value={`每分钟 ${channels.lark_app.per_minute} 条`}
        />
      </SettingsGroup>
      <SettingsGroup title="凭据">
        <Secret label="群机器人 Webhook" state={secrets.lark_webhook} />
        <Secret label="群机器人签名密钥" state={secrets.lark_sign_secret} />
        <Secret label="应用 App ID" state={secrets.app_id} />
        <Secret label="应用 App Secret" state={secrets.app_secret} />
        <Secret label="租户 Tenant Key" state={secrets.tenant_key} />
      </SettingsGroup>
      <SettingsGroup title="高级" collapsible>
        <Value label="请求超时" value={`${advanced.timeout_seconds} 秒`} />
        <Value label="重试次数" value={`${advanced.retry_attempts} 次`} />
        <Value
          label="重试间隔"
          value={`${advanced.retry_interval_seconds} 秒`}
        />
        <Value label="标题长度" value={`${advanced.title_max_chars} 字`} />
        <Value label="汇总条数" value={`${advanced.digest_max_items} 条`} />
        <Value
          label="绑定码有效期"
          value={`${advanced.bind_code_ttl_minutes} 分钟`}
        />
        <Value
          label="按钮有效期"
          value={`${advanced.button_ttl_minutes} 分钟`}
        />
        <Value
          label="每分钟绑定尝试"
          value={`${advanced.bind_attempts_per_minute} 次`}
        />
        <Value label="并发上限" value={`${advanced.max_concurrency} 个`} />
      </SettingsGroup>
    </>
  );
}
