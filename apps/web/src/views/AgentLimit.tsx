import { type ReactNode, useId } from "react";
import type { CardiganClient, MachineView } from "../api.js";
import {
  checkCapacityPolicy,
  runLimitSetting,
  useCapacity,
} from "../components/Capacity.js";
import {
  SettingsFact,
  SettingsFacts,
  SettingsGroup,
  SettingsNumberField,
  SettingsRow,
  SettingsRows,
  SettingsValue,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { useNumberDraft, useSettingWrite } from "./useSettingWrite.js";

/** C-576: why the limit cannot go higher than the host's `max_limit`. */
export const hostMaximumHint = (max: number) =>
  `主机配置的最大值为 ${max}，如需更高请联系主机运维`;

/**
 * One machine's Agent limit, saved on blur or Enter (instant save, C-455).
 * C-511: shown in the machine detail; it was the 并发与容量 panel's row.
 * `limit` comes from `source`, a tracked settings read (the machine read in
 * the detail), so the drawer shows one limit (Q-1013).
 */
export function AgentLimitRow({
  client,
  projectId,
  machineId,
  label,
  limit,
  max,
  mergeCheckSlots = 0,
  description,
  source,
  saved,
}: {
  client: CardiganClient;
  projectId: string;
  machineId: string;
  /** The machine's display name, for the field and its failure notice. */
  label: string;
  limit: number;
  max: number;
  mergeCheckSlots?: number;
  description?: ReactNode;
  source: object;
  saved: () => void;
}) {
  const id = useId();
  const name = `${label} Agent 并发上限`;
  const setting = useSettingWrite({
    name,
    // Labels may repeat; each machine's limit is its own setting.
    id: runLimitSetting(machineId),
    sharedSource: true,
    server: limit,
    source,
    write: (next, key) => client.setRunLimit(projectId, machineId, next, key),
    saved,
    success: () => "并发上限已保存，下一轮调度生效",
  });
  const draft = useNumberDraft(setting.value, 1, max);
  const invalidConfig = limit === 0;
  const tooLarge = /^\d+$/.test(draft.draft) && Number(draft.draft) > max;
  return (
    <SettingsRow
      label="Agent 并发上限"
      htmlFor={id}
      description={description}
      help={
        mergeCheckSlots > 0
          ? `全项目共用，调低上限不会停止已运行的任务。本机合并检查另占 ${mergeCheckSlots} 个 Agent 名额。`
          : "全项目共用，调低上限不会停止已运行的任务。"
      }
      warning={invalidConfig ? "主机并发配置无效，请联系主机管理员" : undefined}
    >
      <SettingsNumberField
        id={id}
        aria-label={name}
        unit="个"
        min={1}
        max={max}
        dirty={draft.dirty}
        invalid={!draft.valid}
        value={draft.draft}
        disabled={invalidConfig}
        readOnly={setting.busy}
        onChange={(event) => {
          draft.setDraft(event.target.value);
          setting.clear();
        }}
        onCommit={() => draft.commit(setting.save)}
      />
      <RequestFeedback
        error={
          invalidConfig || draft.valid
            ? undefined
            : tooLarge
              ? `${hostMaximumHint(max)}。`
              : "并发上限必须为正整数。"
        }
      />
      <RequestFeedback
        interactive
        pending={setting.saving}
        pendingMessage="保存中…"
        error={setting.error}
        message={setting.message}
      />
    </SettingsRow>
  );
}

/** The limit where this session may not change it. */
export function AgentLimitReadOnly({ limit }: { limit: number }) {
  return (
    <SettingsRow label="Agent 并发上限" help="仅人类登录会话可修改并发上限。">
      <SettingsValue>上限 {limit || "不可用"}</SettingsValue>
    </SettingsRow>
  );
}

/**
 * The machine detail's Agent limit: editable in a human session for a
 * machine this project has a binding for, otherwise a plain fact.
 */
export function MachineAgentLimit({
  client,
  projectId,
  machine,
  source,
  saved,
  canEdit,
}: {
  client: CardiganClient;
  projectId: string;
  machine: MachineView;
  /** The detail read that produced `machine`. */
  source: object;
  saved: () => void;
  canEdit: boolean;
}) {
  const slots = useCapacity()?.data?.agents.find(
    (a) => a.machine_id === machine.id,
  )?.merge_check_slots;
  if (!machine.bindings.some((b) => b.is_current))
    return (
      <SettingsFacts>
        <SettingsFact label="Agent 并发">
          {machine.run_limit}（最多可设 {machine.run_limit_maximum}）
        </SettingsFact>
      </SettingsFacts>
    );
  return (
    <SettingsRows>
      {canEdit ? (
        <AgentLimitRow
          client={client}
          projectId={projectId}
          machineId={machine.id}
          label={machine.label}
          limit={machine.run_limit}
          max={machine.run_limit_maximum}
          mergeCheckSlots={slots ?? 0}
          description={
            machine.run_limit >= machine.run_limit_maximum
              ? hostMaximumHint(machine.run_limit_maximum)
              : `最多可设 ${machine.run_limit_maximum} 个`
          }
          source={source}
          saved={saved}
        />
      ) : (
        <AgentLimitReadOnly limit={machine.run_limit} />
      )}
    </SettingsRows>
  );
}

/**
 * C-511: merge check targets from the shared capacity read, read only. Like
 * the machine list (Q-1013/Q-1017), a failed read makes the kept counts
 * "—" until a later read succeeds; the panel shows the error and retry.
 */
export function MergeCheckCapacity() {
  const capacity = useCapacity();
  const data = capacity?.data;
  const stale = capacity?.stale ?? false;
  if (!data || (data.merge_checks.length === 0 && !data.merge_config_invalid))
    return null;
  const count = (n: number) => (stale ? "—" : n);
  return (
    <SettingsGroup title="合并检查">
      {data.merge_checks.map((machine) => (
        <SettingsRow
          key={machine.machine_id}
          label={machine.machine_id}
          description={[
            checkCapacityPolicy(machine),
            `运行中 ${count(machine.running)} / 排队 ${count(machine.queued)}`,
          ]
            .filter(Boolean)
            .join("；")}
          help="需要主机预置，找张良"
        >
          <SettingsValue>
            上限 {stale ? "—" : machine.limit || "不可用"}
          </SettingsValue>
        </SettingsRow>
      ))}
      {data.merge_config_invalid && (
        <SettingsRow
          label="合并检查配置"
          warning="合并检查配置无效，请联系主机管理员。"
        />
      )}
    </SettingsGroup>
  );
}
