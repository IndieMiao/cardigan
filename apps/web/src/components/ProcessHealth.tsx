import { useCallback } from "react";
import type { CardiganClient, ProcessHealthView } from "../api.js";
import { useResource } from "../useResource.js";
import { Time } from "./Foundation.js";
import {
  SettingsFact,
  SettingsFacts,
  SettingsSection,
} from "./layout/SettingsLayout.js";
import { formatBytes } from "./OffsiteStatus.js";
import { RequestFeedback } from "./RequestFeedback.js";

const ROLES: Readonly<
  Record<ProcessHealthView["processes"][number]["role"], string>
> = {
  web: "网页进程",
  background: "后台进程",
  server: "服务进程",
};

type Segment = NonNullable<
  ProcessHealthView["processes"][number]["history"]
>["segments"][number];

const MIB = 1024 * 1024;

/** C-835: heap growth per continuous run, newest run first. */
function formatGrowth(bytesPerDay: number | null) {
  return bytesPerDay === null
    ? "无法计算"
    : `${(bytesPerDay / MIB).toFixed(1)} MB/天`;
}

function Growth({ segments }: { readonly segments: readonly Segment[] }) {
  if (!segments.length) return <>无记录</>;
  return (
    <>
      {[...segments].reverse().map((s) => (
        <div key={s.boot_id}>
          <Time value={s.started_at} /> 起 · {s.points} 点 ·{" "}
          {formatGrowth(s.heap_growth_bytes_per_day)}
        </div>
      ))}
    </>
  );
}

/**
 * C-638: V8 heap use against its limit on the control host; RSS alone does
 * not show how close a process is to running out of heap.
 */
export function ProcessHealthSection({
  client,
}: {
  readonly client: CardiganClient;
}) {
  const load = useCallback(
    async () => (client.processHealth ? client.processHealth() : null),
    [client],
  );
  const state = useResource(load);
  return (
    <SettingsSection title="服务进程">
      <RequestFeedback
        {...state}
        retry={state.reload}
        pendingMessage="正在加载服务进程…"
      />
      {state.data && (
        <SettingsFacts>
          {state.data.processes.flatMap((p) => [
            <SettingsFact key={p.role} label={ROLES[p.role]}>
              堆 {formatBytes(p.heap_used_bytes)} /{" "}
              {formatBytes(p.heap_limit_bytes)} · RSS {formatBytes(p.rss_bytes)}{" "}
              · <Time value={p.checked_at} />
            </SettingsFact>,
            ...(p.history
              ? [
                  <SettingsFact
                    key={`${p.role}-growth`}
                    label={`${ROLES[p.role]}堆增长`}
                  >
                    <Growth segments={p.history.segments} />
                  </SettingsFact>,
                ]
              : []),
          ])}
        </SettingsFacts>
      )}
    </SettingsSection>
  );
}
