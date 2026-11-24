import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  describeError,
  type ReleaseNoteEntryView,
  type ReleaseNotesData,
  type ReleaseNoteView,
} from "../api.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import { EmptyState, Time } from "../components/Foundation.js";
import {
  DataTableCell,
  DataTableId,
  DataTableLayout,
} from "../components/layout/DataTableLayout.js";
import { DialogFeedback } from "../components/layout/DialogFeedbackLayout.js";
import { PageHeader } from "../components/layout/PageHeader.js";
import { useDiscardGuard } from "../components/layout/SettingsLayout.js";
import { Feedback, Markdown } from "../components/Operations.js";
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
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { Textarea } from "../components/ui/textarea.js";
import { useResource } from "../useResource.js";

/** Same ceiling as the C-712 domain rule (code points). */
const MAX_LENGTH = 4000;

function bodyError(body: string): string | undefined {
  if (body.trim().length === 0) return "发版说明正文不能为空";
  if ([...body].length > MAX_LENGTH)
    return `发版说明正文不能超过 ${MAX_LENGTH} 字`;
  return undefined;
}

/**
 * C-713: one project's release notes. Every published version, newest first
 * (the server's order), with its note or "未填写". The person writes or
 * revises a note in a dialog that saves the whole body once; the list then
 * shows the record the server returned and reads the list again.
 */
export function ReleaseNotesPage({
  client,
  projectId,
  revision = 0,
}: {
  client: CardiganClient;
  projectId: string;
  revision?: number;
}) {
  const load = useCallback(
    () => client.releaseNotes(projectId),
    [client, projectId],
  );
  const notes = useResource(load, revision);
  const [editing, setEditing] = useState<ReleaseNoteEntryView>();
  const [feedback, setFeedback] = useState<{
    message?: string;
    error?: string;
  }>({});
  const data = notes.data;

  const copy = async (entry: ReleaseNoteEntryView) => {
    if (!entry.note) return;
    try {
      await navigator.clipboard.writeText(entry.note.body);
      setFeedback({ message: `已复制 ${entry.version} 的发版说明` });
    } catch {
      setFeedback({ error: "复制失败，请选中正文手动复制" });
    }
  };

  const saved = (note: ReleaseNoteView) => {
    // No optimistic update: show the record the server returned, then read
    // the list again for its author view and any concurrent change.
    if (data)
      notes.replace({
        entries: data.entries.map((entry) =>
          entry.version === note.version ? { ...entry, note } : entry,
        ),
      } satisfies ReleaseNotesData);
    notes.reload();
    setEditing(undefined);
    setFeedback({ message: `已保存 ${note.version} 的发版说明` });
  };

  return (
    <section className="ui-workspace" aria-label="发版说明">
      <PageHeader title="发版说明" />
      <Feedback
        pending={notes.pending}
        interactive={notes.interactive}
        error={notes.error}
        retry={notes.reload}
      />
      <RequestFeedback message={feedback.message} error={feedback.error} />
      {data &&
        (data.entries.length === 0 ? (
          <EmptyState>没有发布的版本</EmptyState>
        ) : (
          <DataTableLayout records label="发版说明列表">
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead>发布时间</TableHead>
                <TableHead>作者</TableHead>
                <TableHead>正文</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.entries.map((entry) => (
                <TableRow key={entry.version} data-release-note="">
                  <DataTableCell data-record="lead">
                    <DataTableId>{entry.version}</DataTableId>
                  </DataTableCell>
                  <DataTableCell data-label="发布时间" nowrap>
                    {entry.published_at ? (
                      <Time value={entry.published_at} />
                    ) : (
                      "—"
                    )}
                  </DataTableCell>
                  <DataTableCell data-label="作者" nowrap>
                    {entry.note ? (
                      <EmployeeIdentity
                        {...(entry.note.author_view ?? {
                          author: entry.note.author,
                        })}
                        showTitle={false}
                      />
                    ) : (
                      "—"
                    )}
                  </DataTableCell>
                  <DataTableCell data-label="正文">
                    {entry.note ? (
                      <Markdown body={entry.note.body} />
                    ) : (
                      "未填写"
                    )}
                  </DataTableCell>
                  <DataTableCell data-record="aside" nowrap>
                    {entry.note && (
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label={`复制 ${entry.version} 的发版说明`}
                        onClick={() => void copy(entry)}
                      >
                        复制
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`${entry.note ? "编辑" : "填写"} ${entry.version} 的发版说明`}
                      onClick={() => {
                        setFeedback({});
                        setEditing(entry);
                      }}
                    >
                      {entry.note ? "编辑" : "填写"}
                    </Button>
                  </DataTableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTableLayout>
        ))}
      {editing && (
        <ReleaseNoteEditor
          key={editing.version}
          client={client}
          projectId={projectId}
          entry={editing}
          onSaved={saved}
          onClose={() => setEditing(undefined)}
        />
      )}
    </section>
  );
}

/**
 * Writes or revises one version's note. Saving submits the whole body once;
 * while it runs the dialog cannot be closed. A failure stays in the dialog
 * with the draft and a retry (same idempotency key for the same body).
 * Leaving with unsaved edits asks first; the browser asks on tab close.
 */
function ReleaseNoteEditor({
  client,
  projectId,
  entry,
  onSaved,
  onClose,
}: {
  client: CardiganClient;
  projectId: string;
  entry: ReleaseNoteEntryView;
  onSaved: (note: ReleaseNoteView) => void;
  onClose: () => void;
}) {
  const initial = entry.note?.body ?? "";
  // The revision this draft starts from; the server rejects a stale one.
  const baseRevision = useRef(entry.note?.revision ?? 0).current;
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const attempt = useRef<{ body: string; key: string }>(undefined);
  const focused = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const dirty = draft !== initial;
  const guard = useDiscardGuard(dirty, onClose);
  const verb = entry.note ? "编辑" : "填写";

  async function save() {
    if (saving) return;
    const body = draft;
    const invalid = bodyError(body);
    if (invalid) {
      setError(invalid);
      return;
    }
    // A retry of the same body reuses its key, so a write that did land is
    // replayed instead of becoming a second revision.
    if (attempt.current?.body !== body)
      attempt.current = { body, key: crypto.randomUUID() };
    const key = attempt.current.key;
    setSaving(true);
    setError(undefined);
    try {
      const result = await client.writeReleaseNote(
        projectId,
        { version: entry.version, body, base_revision: baseRevision },
        key,
      );
      if (mounted.current) onSaved(result.note);
    } catch (failure) {
      if (mounted.current) setError(describeError(failure));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) guard.confirmClose();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {verb} {entry.version} 的发版说明
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogFields>
              <label>
                正文
                <Textarea
                  value={draft}
                  rows={12}
                  autoFocus
                  // Continue an existing note at its end.
                  onFocus={(event) => {
                    if (!focused.current) {
                      focused.current = true;
                      const end = event.currentTarget.value.length;
                      event.currentTarget.setSelectionRange(end, end);
                    }
                  }}
                  readOnly={saving}
                  aria-invalid={[...draft].length > MAX_LENGTH || undefined}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
            </DialogFields>
            <DialogFeedback>
              <RequestFeedback
                pending={saving}
                interactive
                pendingMessage="正在保存…"
                error={error}
                retry={saving ? undefined : () => void save()}
              />
            </DialogFeedback>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              size="regular"
              disabled={saving}
              onClick={guard.confirmClose}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="emphasis"
              size="regular"
              disabled={saving || !dirty || draft.trim().length === 0}
            >
              保存
            </Button>
          </DialogFooter>
        </form>
        {guard.dialog}
      </DialogContent>
    </Dialog>
  );
}
