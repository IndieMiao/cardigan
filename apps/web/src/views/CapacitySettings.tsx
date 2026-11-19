import { useId } from "react";
import type { CardiganClient, ExecutionCapacity } from "../api.js";
import { checkCapacityPolicy, useCapacity } from "../components/Capacity.js";
import {
  SettingsGroup,
  SettingsNumberField,
  SettingsPanel,
  SettingsRow,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { useNumberDraft, useSettingWrite } from "./useSettingWrite.js";

/** One machine's Agent limit, saved on blur or Enter (instant save, C-455). */
function AgentLimit({
  machine,
  client,
  projectId,
  saved,
  source,
}: {
  machine: ExecutionCapacity["agents"][number];
  client: CardiganClient;
  projectId: string;
  saved: () => void;
  source: ExecutionCapacity;
}) {
  const id = useId();
  const name = `${machine.label} Agent 并发上限`;
  const setting = useSettingWrite({
    name,
    server: machine.limit,
    source,
    write: (limit, key) =>
      client.setRunLimit(projectId, machine.machine_id, limit, key),
    saved,
    success: () => "并发上限已保存，下一轮调度生效",
  });
  const max = machine.max_limit;
  const draft = useNumberDraft(setting.value, 1, max);
  const invalidConfig = machine.limit === 0;
  const tooLarge = /^\d+$/.test(draft.draft) && Number(draft.draft) > max;
  return (
    <SettingsRow
      label={machine.label}
      htmlFor={id}
      description={`全部 ${machine.total_running} · 非常驻 ${machine.running} / 上限 ${machine.limit || "不可用"} / 排队 ${machine.queued}`}
      help={
        machine.merge_check_slots > 0
          ? `本机合并检查另占 ${machine.merge_check_slots} 个 Agent 名额。`
          : undefined
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
        onCommit={() =>
          // The shared capacity read is not ordered against writes: read the
          // counts again once the new limit is acknowledged.
          draft.commit(async (limit) => {
            const ok = await setting.save(limit);
            if (ok) saved();
            return ok;
          })
        }
      />
      <RequestFeedback
        error={
          invalidConfig || draft.valid
            ? undefined
            : tooLarge
              ? `并发上限不能超过 ${max}。`
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

export function CapacitySettings({
  client,
  projectId,
  hidden = false,
}: {
  client: CardiganClient;
  projectId: string;
  hidden?: boolean;
}) {
  const resource = useCapacity();
  const { data, error, reload, canEdit } = resource ?? {};
  return (
    <SettingsPanel
      hidden={hidden}
      id="capacity"
      tabIndex={-1}
      title="并发与容量"
      titleId="capacity-settings-title"
      help="全项目共用。调低上限不会停止已运行的任务。"
    >
      {resource && (
        <RequestFeedback
          pending={!data && !error}
          pendingMessage="正在读取并发信息…"
          error={error ? `读取并发信息失败：${error}` : undefined}
          retry={reload}
        />
      )}
      {data && !error && (
        <SettingsGroup
          title="Agent 并发"
          description={canEdit ? undefined : "仅人类登录会话可修改并发上限。"}
        >
          {data.agents.length === 0 && <SettingsRow label="暂无 Agent 机器" />}
          {data.agents.map((machine) =>
            canEdit && reload ? (
              <AgentLimit
                key={`${projectId}:${machine.machine_id}`}
                machine={machine}
                client={client}
                projectId={projectId}
                saved={reload}
                source={data}
              />
            ) : (
              <SettingsRow
                key={machine.machine_id}
                label={machine.label}
                description={`全部 ${machine.total_running} · 非常驻 ${machine.running} / 排队 ${machine.queued}`}
              >
                上限 {machine.limit || "不可用"}
              </SettingsRow>
            ),
          )}
        </SettingsGroup>
      )}
      {data && (data.merge_checks.length > 0 || data.merge_config_invalid) && (
        <SettingsGroup title="合并检查">
          {data.merge_checks.map((machine) => (
            <SettingsRow
              key={machine.machine_id}
              label={machine.machine_id}
              description={[
                checkCapacityPolicy(machine),
                `运行中 ${machine.running} / 排队 ${machine.queued}`,
              ]
                .filter(Boolean)
                .join("；")}
              help="需要主机预置，找张良"
            >
              上限 {machine.limit || "不可用"}
            </SettingsRow>
          ))}
          {data.merge_config_invalid && (
            <SettingsRow
              label="合并检查配置"
              warning="合并检查配置无效，请联系主机管理员。"
            />
          )}
        </SettingsGroup>
      )}
    </SettingsPanel>
  );
}
