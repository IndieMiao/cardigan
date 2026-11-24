import { useCallback, useEffect, useRef, useState } from "react";
import type { CardiganClient, PreferencesView, TemplateView } from "../api.js";
import {
  SettingsDialogActions,
  SettingsDialogFields,
  SettingsRow,
  settingsDialogClassName,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import { useResource } from "../useResource.js";
import { useSettingWrite } from "./useSettingWrite.js";

const NAME = "人可开的卡片模板";
const STORY = "story";
const DEFAULT: readonly string[] = [STORY];

/** Only the templates whose state changed, so a save never undoes another. */
function changesOf(from: readonly string[], next: readonly string[]) {
  return Object.fromEntries([
    ...next.filter((id) => !from.includes(id)).map((id) => [id, true]),
    ...from.filter((id) => !next.includes(id)).map((id) => [id, false]),
  ]);
}

/**
 * C-684: which templates a person may open cards from. The list saves as one
 * dialog, but each save sends only the templates the person ticked or cleared.
 */
export function HumanCardTemplatesSetting({
  allowed,
  client,
  projectId,
  saved,
  source,
}: {
  allowed: readonly string[] | undefined;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
  source: PreferencesView | undefined;
}) {
  const templates = useResource(
    useCallback(() => client.templates(projectId), [client, projectId]),
  );
  // The list the dialog's draft started from: the save is a diff against it.
  const basis = useRef<readonly string[]>(allowed ?? DEFAULT);
  const setting = useSettingWrite<readonly string[]>({
    name: NAME,
    server: allowed ?? DEFAULT,
    source,
    write: (next, key) =>
      client.setHumanCardTemplates(
        projectId,
        changesOf(basis.current, next),
        key,
      ),
    saved,
    success: () => "人可开的卡片模板已保存",
  });
  const title = (id: string) =>
    templates.data?.templates.find((t) => t.id === id)?.title ?? id;
  return (
    <SettingsRow
      label={NAME}
      description={setting.value.map(title).join("、")}
      help="人在 Workbench 和命令行开卡时只能用这些模板，需求卡始终可用。Agent、PM 开卡，以及确认拆解方案生成的子卡不受限制。"
    >
      <HumanCardTemplatesDialog
        allowed={setting.value}
        templates={templates.data?.templates}
        templatesError={templates.error}
        reloadTemplates={templates.reload}
        busy={setting.busy}
        saving={setting.saving}
        error={setting.error}
        message={setting.message}
        save={(from, next) => {
          basis.current = from;
          return setting.save(next);
        }}
      />
    </SettingsRow>
  );
}

function HumanCardTemplatesDialog({
  allowed,
  templates,
  templatesError,
  reloadTemplates,
  busy,
  saving,
  error,
  message,
  save,
}: {
  allowed: readonly string[];
  templates: readonly TemplateView[] | undefined;
  templatesError: string | undefined;
  reloadTemplates: () => void;
  /** Editing locked: saving, or the read shown is known to be old. */
  busy: boolean;
  saving: boolean;
  error: string;
  message: string;
  save: (from: readonly string[], next: readonly string[]) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(allowed);
  const [from, setFrom] = useState(allowed);
  const [updated, setUpdated] = useState("");
  const reset = () => {
    setFrom(allowed);
    setDraft(allowed);
    setUpdated("");
  };
  // A newer read while open replaces the draft, as the reminder policy does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new confirmed list is the trigger.
  useEffect(() => {
    if (!open || saving || JSON.stringify(allowed) === JSON.stringify(from))
      return;
    const changed = JSON.stringify(draft) !== JSON.stringify(allowed);
    reset();
    if (changed) setUpdated("人可开的卡片模板已更新为最新值");
  }, [allowed, open, saving]);
  const choices = (templates ?? []).filter(
    (t) => t.status === "active" || draft.includes(t.id),
  );
  const toggle = (id: string, on: boolean) =>
    setDraft((current) =>
      on
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((x) => x !== id),
    );
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next ? busy : saving) return;
          if (next) reset();
          setOpen(next);
        }}
      >
        <DialogTrigger asChild>
          <Button aria-label={`编辑${NAME}`} aria-disabled={busy}>
            编辑
          </Button>
        </DialogTrigger>
        <DialogContent
          className={settingsDialogClassName}
          aria-describedby={undefined}
        >
          <DialogTitle>{NAME}</DialogTitle>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy || !templates) return;
              setUpdated("");
              const added = draft.filter((id) => !from.includes(id));
              // Keep the stored order: kept templates first, new ones after.
              const next = [
                ...from.filter((id) => draft.includes(id)),
                ...added,
              ];
              if (Object.keys(changesOf(from, next)).length === 0)
                return setOpen(false);
              if (await save(from, next)) setOpen(false);
            }}
          >
            <SettingsDialogFields>
              <fieldset>
                <legend>模板</legend>
                <div data-choices="">
                  {choices.map((t) => (
                    <label key={t.id}>
                      <Checkbox
                        checked={t.id === STORY || draft.includes(t.id)}
                        disabled={busy || t.id === STORY}
                        onCheckedChange={(on) => toggle(t.id, on === true)}
                      />
                      {t.title}
                    </label>
                  ))}
                </div>
              </fieldset>
            </SettingsDialogFields>
            {templatesError && (
              <Button type="button" onClick={reloadTemplates}>
                重试
              </Button>
            )}
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
              <Button
                type="submit"
                variant="primary"
                aria-disabled={busy || !templates}
              >
                保存可开模板
              </Button>
            </SettingsDialogActions>
            <RequestFeedback
              interactive
              pending={saving}
              pendingMessage="正在保存人可开的卡片模板…"
              error={error || templatesError || ""}
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
