import { useState } from "react";
import {
  type CardiganClient,
  describeError,
  type MachineReservationView,
  type MachineView,
} from "../api.js";
import { Time } from "../components/Foundation.js";
import { DataTableCell } from "../components/layout/DataTableLayout.js";
import {
  SettingsConfirmDialog,
  SettingsSection,
  SettingsTable,
} from "../components/layout/SettingsLayout.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { Button } from "../components/ui/button.js";
import { DialogFields } from "../components/ui/dialog.js";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { Textarea } from "../components/ui/textarea.js";

export const RESERVATION_SOURCE_LABELS: Record<
  MachineReservationView["source"],
  string
> = {
  human: "人工",
  standing_pm: "常驻 PM",
  unknown: "未登记",
};

/**
 * C-800: every project's open calendar reservations on this machine. The
 * owner's session can end one early after confirming with a reason; the
 * detail and list are then read again.
 */
export function MachineReservations({
  client,
  projectId,
  machine,
  canEdit,
  onChanged,
}: {
  client: CardiganClient;
  projectId: string;
  machine: MachineView;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const reservations = machine.reservations ?? [];
  const cancellable = canEdit && !!client.cancelMachineReservation;
  const [asking, setAsking] = useState<MachineReservationView>();
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{
    pending?: boolean;
    message?: string;
    error?: string;
  }>({});
  const confirm = async () => {
    const target = asking;
    if (!target || !client.cancelMachineReservation || !reason.trim()) return;
    setAsking(undefined);
    setState({ pending: true });
    try {
      await client.cancelMachineReservation(
        projectId,
        machine.id,
        target.reservation_id,
        reason.trim(),
      );
      setState({ message: `已取消预约 ${target.reservation_id}` });
    } catch (error) {
      setState({ error: describeError(error) });
    } finally {
      setReason("");
      onChanged();
    }
  };
  return (
    <SettingsSection title="资源预约">
      <RequestFeedback
        interactive
        pending={state.pending ?? false}
        pendingMessage="正在取消预约…"
        message={state.message}
        error={state.error}
      />
      {reservations.length === 0 ? (
        <p>没有预约</p>
      ) : (
        <SettingsTable aria-label="资源预约">
          <TableHeader>
            <TableRow>
              <TableHead>资源</TableHead>
              <TableHead>持有项目</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>开始</TableHead>
              <TableHead>结束</TableHead>
              <TableHead>预约编号</TableHead>
              {cancellable && <TableHead>操作</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {reservations.map((r) => (
              <TableRow key={r.reservation_id}>
                <DataTableCell nowrap data-record="lead">
                  <code>{r.resource}</code>
                </DataTableCell>
                <DataTableCell nowrap data-label="持有项目">
                  {r.holder_project}
                </DataTableCell>
                <DataTableCell nowrap data-label="来源">
                  {RESERVATION_SOURCE_LABELS[r.source]}
                </DataTableCell>
                <DataTableCell nowrap data-label="开始">
                  <Time value={r.starts_at} />
                </DataTableCell>
                <DataTableCell nowrap data-label="结束">
                  <Time value={r.ends_at} />
                </DataTableCell>
                <DataTableCell data-label="预约编号">
                  <code>{r.reservation_id}</code>
                </DataTableCell>
                {cancellable && (
                  <DataTableCell nowrap data-record="aside">
                    <Button
                      aria-label={`取消预约 ${r.reservation_id}`}
                      aria-disabled={state.pending || undefined}
                      onClick={() => {
                        if (state.pending) return;
                        setReason("");
                        setAsking(r);
                      }}
                    >
                      取消预约
                    </Button>
                  </DataTableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </SettingsTable>
      )}
      <SettingsConfirmDialog
        open={!!asking}
        title="取消这个预约？"
        description={
          asking
            ? `${asking.resource} 的预约（持有项目 ${asking.holder_project}）将立即结束，被挡的任务会重新排队。`
            : ""
        }
        cancelLabel="保留预约"
        confirmLabel="取消预约"
        destructive
        confirmDisabled={!reason.trim()}
        onCancel={() => setAsking(undefined)}
        onConfirm={() => void confirm()}
      >
        <DialogFields>
          <label>
            取消原因
            <Textarea
              rows={3}
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        </DialogFields>
      </SettingsConfirmDialog>
    </SettingsSection>
  );
}
