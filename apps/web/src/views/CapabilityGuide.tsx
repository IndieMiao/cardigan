import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CapabilityGuidesView,
  type CapabilityGuideTarget,
  type CardiganClient,
  describeWriteError,
  type MachineView,
} from "../api.js";
import { DialogFeedback } from "../components/layout/DialogFeedbackLayout.js";
import {
  SettingsFact,
  SettingsFacts,
  settingsDrawerDialogClassName,
  settingsDrawerOverlayClassName,
  useDiscardGuard,
} from "../components/layout/SettingsLayout.js";
import { Markdown } from "../components/Operations.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFields,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Textarea } from "../components/ui/textarea.js";
import { useResource } from "../useResource.js";

/**
 * C-727: the usage notes (C-725) of one machine's capabilities in its
 * drawer, beside the capability rows of the current project. Reads go with
 * the drawer's revision; the owner's human session edits them in a dialog
 * that saves on 保存 (state and save of the card): only changed notes are
 * sent, a failure keeps the draft, and the notes are read again after every
 * write, before anything may be edited again.
 */
export interface CapabilityNote {
  readonly usage_note: string | null;
  readonly machine_note: string | null;
}

/** Orders guide reads against writes: only a read started later counts. */
let clock = 0;
const readTicks = new WeakMap<object, number>();

export function useCapabilityGuides(
  client: CardiganClient,
  projectId: string,
  machineId: string,
  revision: number,
) {
  const supported = !!client.capabilityGuides;
  const load = useMemo(
    () => async (): Promise<CapabilityGuidesView | undefined> => {
      const at = ++clock;
      const data = await client.capabilityGuides?.(projectId, machineId);
      if (data) readTicks.set(data, at);
      return data;
    },
    [client, projectId, machineId],
  );
  const read = useResource(load, revision, supported);
  /** When the last write ended; a read must start after it. */
  const [fence, setFence] = useState(0);
  const reload = read.reload;
  const written = useCallback(() => {
    setFence(++clock);
    reload();
  }, [reload]);
  const notes = useMemo(() => {
    const map = new Map<string, CapabilityNote>();
    for (const c of read.data?.merged.capabilities ?? [])
      if (c.usage_note !== null || c.machine_note !== null) map.set(c.key, c);
    return map;
  }, [read.data]);
  const fresh = !!read.data && (readTicks.get(read.data) ?? 0) > fence;
  return {
    supported,
    notes,
    /** The notes as last read, or nothing yet: edits start from them. */
    note: (key: string): CapabilityNote =>
      notes.get(key) ?? { usage_note: null, machine_note: null },
    /** Read after the last write ended: editing may start or submit. */
    fresh,
    written,
    feedback: supported
      ? {
          error: read.error && `使用说明未能读取：${read.error}`,
          retry: read.reload,
          pending: read.pending && read.interactive,
          interactive: read.interactive,
          pendingMessage: "正在读取使用说明…",
        }
      : {},
  };
}

/** Under a capability row: the main note, then this machine's supplement. */
export function CapabilityNotes({ note }: { note: CapabilityNote }) {
  return (
    <SettingsFacts>
      {note.usage_note !== null && (
        <SettingsFact label="使用说明">
          <Markdown body={note.usage_note} />
        </SettingsFact>
      )}
      {note.machine_note !== null && (
        <SettingsFact label="本机补充">
          <Markdown body={note.machine_note} />
        </SettingsFact>
      )}
    </SettingsFacts>
  );
}

type Field = "usage_note" | "machine_note";
const FIELDS: readonly Field[] = ["usage_note", "machine_note"];
/** As the server stores it: one kind of line ending, no outer whitespace. */
const normalized = (text: string) => text.replace(/\r\n?/g, "\n").trim();

export function CapabilityGuideDialog({
  client,
  projectId,
  machine,
  capabilityKey,
  note,
  locked,
  onWritten,
  onSaved,
  onClose,
}: {
  client: CardiganClient;
  projectId: string;
  machine: MachineView;
  capabilityKey: string;
  /** The notes as last read when the dialog opened. */
  note: CapabilityNote;
  /** A read after the last write has not arrived: 保存 waits for it. */
  locked: boolean;
  /** Every write's end, success or not: the notes are read again. */
  onWritten: () => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<Field, string>>({
    usage_note: note.usage_note ?? "",
    machine_note: note.machine_note ?? "",
  });
  // What the server holds as far as this dialog knows: the notes it opened
  // with, then each note it saved. Only notes that differ are sent.
  const saved = useRef<Record<Field, string>>({
    usage_note: normalized(note.usage_note ?? ""),
    machine_note: normalized(note.machine_note ?? ""),
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const changed = FIELDS.filter(
    (field) => normalized(draft[field]) !== saved.current[field],
  );
  const dirty = changed.length > 0;
  const guard = useDiscardGuard(dirty, onClose);
  const opener = useRef<HTMLElement | null>(null);
  const targetOf = (field: Field): CapabilityGuideTarget =>
    field === "usage_note"
      ? { scope: "capability", key: capabilityKey, machine_id: null }
      : { scope: "machine", key: capabilityKey, machine_id: machine.id };
  const save = async () => {
    if (pending || locked || !dirty) return;
    setPending(true);
    setError("");
    let failed: string | undefined;
    for (const field of changed) {
      const text = normalized(draft[field]);
      try {
        if (text)
          await client.setCapabilityGuide?.(projectId, targetOf(field), text);
        else await client.deleteCapabilityGuide?.(projectId, targetOf(field));
        saved.current[field] = text;
      } catch (failure) {
        failed = `${field === "usage_note" ? "使用说明" : "本机补充"}未保存：${describeWriteError(failure)}`;
        break;
      }
    }
    onWritten();
    if (!alive.current) return;
    setPending(false);
    if (failed) setError(failed);
    else onSaved();
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next && !pending) guard.confirmClose();
        }}
      >
        <DialogContent
          className={settingsDrawerDialogClassName}
          overlayClassName={settingsDrawerOverlayClassName}
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            // Still the 编辑说明 button: focus moves in after this.
            opener.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (opener.current?.isConnected
              ? opener.current
              : document.querySelector<HTMLElement>("[aria-label='关闭抽屉']")
            )?.focus();
          }}
        >
          <form
            aria-label={`${capabilityKey} 使用说明`}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <DialogHeader>
              <DialogTitle>{capabilityKey} 使用说明</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DialogFields>
                <label>
                  使用说明
                  <Textarea
                    rows={8}
                    value={draft.usage_note}
                    disabled={pending}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, usage_note: e.target.value }))
                    }
                  />
                </label>
                <label>
                  本机补充（{machine.label}）
                  <Textarea
                    rows={4}
                    value={draft.machine_note}
                    disabled={pending}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, machine_note: e.target.value }))
                    }
                  />
                </label>
              </DialogFields>
              <DialogFeedback>
                <RequestFeedback
                  interactive
                  pending={pending}
                  pendingMessage="正在保存使用说明…"
                  error={error || undefined}
                />
              </DialogFeedback>
            </DialogBody>
            <DialogFooter>
              <Button
                size="regular"
                disabled={pending}
                onClick={guard.confirmClose}
              >
                取消
              </Button>
              <Button
                type="submit"
                size="regular"
                variant="emphasis"
                disabled={!dirty || pending}
                aria-disabled={locked || undefined}
              >
                保存使用说明
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {guard.dialog}
    </>
  );
}
