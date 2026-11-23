import { useCallback } from "react";
import type { CardiganClient, OffsiteStatusView } from "../api.js";
import { useResource } from "../useResource.js";
import { StatusTag, Time } from "./Foundation.js";
import {
  SettingsFact,
  SettingsFacts,
  SettingsSection,
} from "./layout/SettingsLayout.js";
import { RequestFeedback } from "./RequestFeedback.js";

const ALERTS: Readonly<Record<OffsiteStatusView["alerts"][number], string>> = {
  config_invalid: "配置无效",
  unreachable: "OSS 不可达",
  sync_failed: "同步失败",
  over_budget: "超出月度上限",
};

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function OffsiteState({ status }: { status: OffsiteStatusView }) {
  if (status.configured === "absent")
    return <StatusTag status="inactive" label="未配置" subdued />;
  if (status.alerts.length)
    return (
      <StatusTag
        status="failed"
        label={status.alerts.map((a) => ALERTS[a]).join("、")}
      />
    );
  return <StatusTag status="passed" label="正常" />;
}

/**
 * C-614: off-site copy of attachments and artifacts, shown on the control
 * host. Alerts never stop uploads, reads or dispatch.
 */
export function OffsiteStatusSection({
  client,
}: {
  readonly client: CardiganClient;
}) {
  const load = useCallback(
    async () => (client.offsiteStatus ? client.offsiteStatus() : null),
    [client],
  );
  const state = useResource(load);
  const status = state.data;
  return (
    <SettingsSection title="异地副本">
      <RequestFeedback
        {...state}
        retry={state.reload}
        pendingMessage="正在加载异地副本…"
      />
      {status === null && <p>未配置</p>}
      {status && (
        <SettingsFacts>
          <SettingsFact label="状态">
            <OffsiteState status={status} />
          </SettingsFact>
          {status.bucket && (
            <SettingsFact label="存储桶">
              <code>{status.bucket}</code> {status.region}
            </SettingsFact>
          )}
          <SettingsFact label="已同步">
            {status.synced.count} 个 · {formatBytes(status.synced.bytes)}
          </SettingsFact>
          <SettingsFact label="待同步">
            {status.pending.count} 个 · {formatBytes(status.pending.bytes)}
          </SettingsFact>
          <SettingsFact label="同步失败">
            {status.failed.count}
            {status.failed.last_code && ` · ${status.failed.last_code}`}
          </SettingsFact>
          <SettingsFact label="最近成功">
            {status.last_success_at ? (
              <Time value={status.last_success_at} />
            ) : (
              "—"
            )}
          </SettingsFact>
          <SettingsFact label={`${status.usage.month} 估算费用`}>
            ¥{status.usage.estimated_yuan.toFixed(2)}
            {status.usage.budget_yuan !== undefined &&
              ` / 上限 ¥${status.usage.budget_yuan}`}
          </SettingsFact>
          <SettingsFact label="本月流量">
            {formatBytes(status.usage.egress_bytes)}
          </SettingsFact>
          <SettingsFact label="本月图片处理">
            {formatBytes(status.usage.process_bytes)}
          </SettingsFact>
        </SettingsFacts>
      )}
    </SettingsSection>
  );
}
