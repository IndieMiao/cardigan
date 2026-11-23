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
          {state.data.processes.map((p) => (
            <SettingsFact key={p.role} label={ROLES[p.role]}>
              堆 {formatBytes(p.heap_used_bytes)} /{" "}
              {formatBytes(p.heap_limit_bytes)} · RSS {formatBytes(p.rss_bytes)}{" "}
              · <Time value={p.checked_at} />
            </SettingsFact>
          ))}
        </SettingsFacts>
      )}
    </SettingsSection>
  );
}
