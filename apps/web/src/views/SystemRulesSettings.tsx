import { useEffect, useId, useState } from "react";
import type {
  CardiganClient,
  PreferencesView,
  SystemReminderPolicy,
} from "../api.js";
import {
  SettingsDialogActions,
  SettingsDialogFields,
  SettingsGroup,
  SettingsRow,
  settingsDialogClassName,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { toggleFailure, useSettingWrite } from "./useSettingWrite.js";

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

interface Props {
  initial: PreferencesView;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
  source: PreferencesView | undefined;
}

/**
 * Auto-assign and reminders save instantly; the reminder policy saves as one
 * dialog. Each write sends only its own field, so it cannot undo another.
 */
export function SystemRulesSettings({
  initial,
  client,
  projectId,
  saved,
  source,
}: Props) {
  const id = useId();
  const rule = (
    name: string,
    server: boolean,
    field: "system_auto_assign_verifiers" | "system_reminders",
    success: (value: boolean) => string,
  ) => ({
    name,
    failure: toggleFailure(name),
    server,
    source,
    write: (value: boolean, key: string) =>
      client.setSystemRules(projectId, { [field]: value }, key),
    saved,
    success,
  });
  const assign = useSettingWrite(
    rule(
      "自动指派验证项",
      initial.system_auto_assign_verifiers === true,
      "system_auto_assign_verifiers",
      (next) => (next ? "已开启自动指派验证项" : "已关闭自动指派验证项"),
    ),
  );
  const remind = useSettingWrite(
    rule(
      "催办提醒",
      initial.system_reminders === true,
      "system_reminders",
      (next) => (next ? "已开启催办提醒" : "已关闭催办提醒"),
    ),
  );
  const policy = useSettingWrite<SystemReminderPolicy | null>({
    name: "催办阈值",
    server: initial.system_reminder_policy ?? null,
    source,
    write: (value, key) =>
      client.setSystemRules(projectId, { system_reminder_policy: value }, key),
    saved,
    success: () => "催办阈值已保存",
  });
  return (
    <SettingsGroup title="自动指派与催办">
      <SettingsRow
        label="自动指派验证项"
        labelId={`${id}-assign`}
        description="包括完成验收；手动指派的工作项会跳过。"
        descriptionId={`${id}-assign-help`}
      >
        <Switch
          checked={assign.value}
          aria-disabled={assign.busy}
          aria-labelledby={`${id}-assign`}
          aria-describedby={`${id}-assign-help`}
          onCheckedChange={assign.save}
        />
        <RequestFeedback
          interactive
          pending={assign.saving}
          pendingMessage="正在保存…"
          error={assign.error}
          message={assign.message}
        />
      </SettingsRow>
      <SettingsRow
        label="催办提醒"
        labelId={`${id}-remind`}
        description="没有完整的催办阈值就不催办；手动指派的工作项会跳过。"
        descriptionId={`${id}-remind-help`}
      >
        <Switch
          checked={remind.value}
          aria-disabled={remind.busy}
          aria-labelledby={`${id}-remind`}
          aria-describedby={`${id}-remind-help`}
          onCheckedChange={remind.save}
        />
        <RequestFeedback
          interactive
          pending={remind.saving}
          pendingMessage="正在保存…"
          error={remind.error}
          message={remind.message}
        />
      </SettingsRow>
      <SettingsRow
        label="催办阈值"
        description={
          policy.value
            ? policy.value.repeat
              ? "已设置，重复提醒"
              : "已设置，每个等待周期提醒一次"
            : "未设置"
        }
      >
        <ReminderPolicyDialog
          policy={policy.value}
          busy={policy.busy}
          saving={policy.saving}
          error={policy.error}
          message={policy.message}
          save={policy.save}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * The dialog stays open while saving, so a failure keeps its error and draft.
 * A failure stays visible until the next save: in the dialog while open, in
 * the shared feedback stack once closed. The draft always starts from the
 * latest confirmed policy: the dialog cannot open while the read shown is
 * known to be old, and a newer read arriving while it is open replaces the
 * draft, so an older snapshot is never written back.
 */
function ReminderPolicyDialog({
  policy,
  busy,
  saving,
  error,
  message,
  save,
}: {
  policy: SystemReminderPolicy | null;
  /** Editing locked: saving, or the read shown is known to be old. */
  busy: boolean;
  saving: boolean;
  error: string;
  message: string;
  save: (policy: SystemReminderPolicy | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [configure, setConfigure] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  /** The policy the draft was taken from. */
  const [from, setFrom] = useState(policy);
  const [updated, setUpdated] = useState("");
  const build = (): SystemReminderPolicy | null =>
    configure
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
  const reset = () => {
    setFrom(policy);
    setUpdated("");
    setConfigure(!!policy);
    setRepeat(policy?.repeat === true);
    setValues(
      Object.fromEntries(
        fields.map(([key]) => [key, String(policy?.[key] ?? "")]),
      ),
    );
  };
  // A newer read while open replaces the draft; it says so unless the draft
  // already matched (e.g. a save whose reply was lost took effect).
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new confirmed policy is the trigger.
  useEffect(() => {
    if (!open || saving || JSON.stringify(policy) === JSON.stringify(from))
      return;
    const changed = JSON.stringify(build()) !== JSON.stringify(policy);
    reset();
    if (changed) setUpdated("催办阈值已更新为最新值");
  }, [policy, open, saving]);
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Opening needs the latest value; closing only waits for a save.
          if (next ? busy : saving) return;
          if (next) reset();
          setOpen(next);
        }}
      >
        <DialogTrigger asChild>
          <Button aria-label="编辑催办阈值" aria-disabled={busy}>
            编辑
          </Button>
        </DialogTrigger>
        <DialogContent className={settingsDialogClassName}>
          <DialogTitle>催办阈值</DialogTitle>
          <DialogDescription>
            没有完整配置就不催办；不重复时每个等待周期只提醒一次。
          </DialogDescription>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setUpdated("");
              if (await save(build())) setOpen(false);
            }}
          >
            <SettingsDialogFields>
              <label>
                设置催办阈值和允许范围
                <Switch
                  checked={configure}
                  disabled={busy}
                  onCheckedChange={setConfigure}
                />
              </label>
              {configure && (
                <label>
                  重复提醒
                  <Switch
                    checked={repeat}
                    disabled={busy}
                    onCheckedChange={(next) => {
                      setRepeat(next);
                      if (!next)
                        setValues((v) => ({
                          ...v,
                          repeat_interval_minutes: "",
                        }));
                    }}
                  />
                </label>
              )}
              {configure &&
                fields.map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <Input
                      type="number"
                      step="1"
                      value={values[key] ?? ""}
                      placeholder="未设置"
                      disabled={
                        busy || (key === "repeat_interval_minutes" && !repeat)
                      }
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [key]: e.target.value }))
                      }
                    />
                  </label>
                ))}
            </SettingsDialogFields>
            <SettingsDialogActions>
              <Button
                type="button"
                aria-disabled={saving}
                onClick={() => {
                  if (!saving) setOpen(false);
                }}
              >
                取消
              </Button>
              <Button type="submit" variant="primary" aria-disabled={busy}>
                保存催办阈值
              </Button>
            </SettingsDialogActions>
            <RequestFeedback
              interactive
              pending={saving}
              pendingMessage="正在保存催办阈值…"
              error={error}
              message={updated}
            />
          </form>
        </DialogContent>
      </Dialog>
      <RequestFeedback
        interactive
        error={open ? undefined : error}
        message={message}
      />
    </>
  );
}
