import { useEffect, useId, useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type PreferencesView,
  type SystemReminderPolicy,
  type SystemRulesPreferences,
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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";

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

/** Auto-assign and reminders save instantly; the reminder policy saves as one dialog. */
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
  const id = useId();
  const current: Required<SystemRulesPreferences> = {
    system_auto_assign_verifiers: initial.system_auto_assign_verifiers === true,
    system_reminders: initial.system_reminders === true,
    system_reminder_policy: initial.system_reminder_policy ?? null,
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // Dialog saves report inside the modal; Radix hides the page from assistive tech.
  const [origin, setOrigin] = useState<"row" | "dialog">("row");
  const sending = useRef(false);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);
  const write = async (
    patch: Partial<SystemRulesPreferences>,
    from: "row" | "dialog" = "row",
  ) => {
    if (sending.current) return false;
    sending.current = true;
    setOrigin(from);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await client.setSystemRules(
        projectId,
        { ...current, ...patch },
        crypto.randomUUID(),
      );
      setMessage("系统规则已保存");
      saved();
      return true;
    } catch (cause) {
      setError(describeWriteError(cause));
      return false;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const policy = current.system_reminder_policy;
  return (
    <SettingsGroup title="自动指派与催办">
      <SettingsRow
        label="自动指派验证项"
        labelId={`${id}-assign`}
        description="包括完成验收；手动指派的工作项会跳过。"
        descriptionId={`${id}-assign-help`}
      >
        <Switch
          checked={current.system_auto_assign_verifiers}
          aria-disabled={busy}
          aria-labelledby={`${id}-assign`}
          aria-describedby={`${id}-assign-help`}
          onCheckedChange={(next) =>
            write({ system_auto_assign_verifiers: next })
          }
        />
      </SettingsRow>
      <SettingsRow
        label="催办提醒"
        labelId={`${id}-remind`}
        description="没有完整的催办阈值就不催办；手动指派的工作项会跳过。"
        descriptionId={`${id}-remind-help`}
      >
        <Switch
          checked={current.system_reminders}
          aria-disabled={busy}
          aria-labelledby={`${id}-remind`}
          aria-describedby={`${id}-remind-help`}
          onCheckedChange={(next) => write({ system_reminders: next })}
        />
      </SettingsRow>
      <SettingsRow
        label="催办阈值"
        description={
          policy
            ? policy.repeat
              ? "已设置，重复提醒"
              : "已设置，每个等待周期提醒一次"
            : "未设置"
        }
      >
        <ReminderPolicyDialog
          policy={policy}
          busy={busy}
          error={origin === "dialog" ? error : ""}
          save={(next) => write({ system_reminder_policy: next }, "dialog")}
        />
      </SettingsRow>
      <RequestFeedback
        interactive
        pending={busy && origin === "row"}
        pendingMessage="正在保存…"
        error={origin === "row" ? error : ""}
        message={message}
      />
    </SettingsGroup>
  );
}

function ReminderPolicyDialog({
  policy,
  busy,
  error,
  save,
}: {
  policy: SystemReminderPolicy | null;
  busy: boolean;
  error: string;
  save: (policy: SystemReminderPolicy | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [configure, setConfigure] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const reset = () => {
    setConfigure(!!policy);
    setRepeat(policy?.repeat === true);
    setValues(
      Object.fromEntries(
        fields.map(([key]) => [key, String(policy?.[key] ?? "")]),
      ),
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <Button
        aria-label="编辑催办阈值"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        编辑
      </Button>
      <DialogContent className={settingsDialogClassName}>
        <DialogTitle>催办阈值</DialogTitle>
        <DialogDescription>
          没有完整配置就不催办；不重复时每个等待周期只提醒一次。
        </DialogDescription>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const next = configure
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
            if (await save(next)) setOpen(false);
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
                      setValues((v) => ({ ...v, repeat_interval_minutes: "" }));
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
            <DialogClose asChild>
              <Button>取消</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy}>
              保存催办阈值
            </Button>
          </SettingsDialogActions>
          <RequestFeedback
            interactive
            pending={busy}
            pendingMessage="正在保存催办阈值…"
            error={error}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
