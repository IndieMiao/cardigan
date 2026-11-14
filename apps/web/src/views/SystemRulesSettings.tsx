import { useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type PreferencesView,
  type SystemReminderPolicy,
} from "../api.js";

const fields = [
  ["min_minutes", "允许的最少分钟数"],
  ["max_minutes", "允许的最多分钟数"],
  ["min_count", "允许的最少提醒次数"],
  ["max_count", "允许的最多提醒次数"],
  ["unassigned_ready_after_minutes", "就绪未指派：等待分钟数（留空关闭）"],
  [
    "pre_merge_check_pending_after_minutes",
    "核对待完成：等待分钟数（留空关闭）",
  ],
  ["repeat_interval_minutes", "重复提醒间隔（分钟，不重复时留空）"],
  ["max_reminders", "每个等待周期最多提醒次数"],
] as const;

export function SystemRulesSettings({
  initial,
  client,
  projectId,
  saved,
}: {
  initial: PreferencesView;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}) {
  const [assign, setAssign] = useState(
    initial.system_auto_assign_verifiers === true,
  );
  const [remind, setRemind] = useState(initial.system_reminders === true);
  const [configure, setConfigure] = useState(!!initial.system_reminder_policy);
  const [repeat, setRepeat] = useState(
    initial.system_reminder_policy?.repeat === true,
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map(([key]) => [
        key,
        String(initial.system_reminder_policy?.[key] ?? ""),
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        try {
          const policy = configure
            ? ({
                ...Object.fromEntries(
                  fields.map(([key]) => [
                    key,
                    values[key]?.trim() ? Number(values[key]) : null,
                  ]),
                ),
                repeat,
              } as unknown as SystemReminderPolicy)
            : null;
          await client.setSystemRules(
            projectId,
            {
              system_auto_assign_verifiers: assign,
              system_reminders: remind,
              system_reminder_policy: policy,
            },
            crypto.randomUUID(),
          );
          setMessage("系统规则已保存");
          saved();
        } catch (error) {
          setMessage(describeWriteError(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>自动指派与催办</h3>
      <p>两项独立控制，未设置时关闭。手动指派的工作项会跳过自动指派和催办。</p>
      <label>
        <input
          type="checkbox"
          checked={assign}
          disabled={busy}
          onChange={(e) => setAssign(e.target.checked)}
        />
        自动指派验证项（含完成验收）
      </label>
      <label>
        <input
          type="checkbox"
          checked={remind}
          disabled={busy}
          onChange={(e) => setRemind(e.target.checked)}
        />
        启用催办提醒
      </label>
      <label>
        <input
          type="checkbox"
          checked={configure}
          disabled={busy}
          onChange={(e) => setConfigure(e.target.checked)}
        />
        设置催办阈值和允许范围
      </label>
      <p>
        没有完整配置就不催办；请自行填写允许范围和阈值。不重复时每个等待周期只提醒一次。
      </p>
      {configure && (
        <fieldset disabled={busy}>
          <legend>催办设置</legend>
          <label>
            <input
              type="checkbox"
              checked={repeat}
              onChange={(e) => {
                setRepeat(e.target.checked);
                if (!e.target.checked)
                  setValues((v) => ({ ...v, repeat_interval_minutes: "" }));
              }}
            />
            重复提醒
          </label>
          {fields.map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                step="1"
                value={values[key]}
                placeholder="未设置"
                disabled={key === "repeat_interval_minutes" && !repeat}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [key]: e.target.value }))
                }
              />
            </label>
          ))}
        </fieldset>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "正在保存…" : "保存自动指派与催办"}
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
