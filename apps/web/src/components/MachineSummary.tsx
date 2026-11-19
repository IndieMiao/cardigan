import type { ExecutionMachine } from "../api.js";
import { capabilityState } from "../machine-labels.js";
import { useCapacity } from "./Capacity.js";
import { IdTag, StatusTag } from "./Foundation.js";
import { MachineHealthTag, machineCapacityText } from "./MachineDetail.js";
import { Button } from "./ui/button.js";

/** One line per registered machine; the drawer carries capabilities and resources. */
export function MachineSummary({
  machine,
  open,
  onOpen,
}: {
  readonly machine: ExecutionMachine;
  readonly open: boolean;
  readonly onOpen: (trigger: HTMLElement) => void;
}) {
  const capacity = machineCapacityText(
    useCapacity()?.data?.agents.find((row) => row.machine_id === machine.id),
  );
  const capabilities = machine.capabilities ?? [];
  const verified = capabilities.filter(
    (capability) => capabilityState(capability) === "verified",
  ).length;
  return (
    <li>
      <IdTag id={machine.id} label={machine.label} />{" "}
      <StatusTag status={machine.status} />{" "}
      <MachineHealthTag machine={machine} />
      {capacity && <span> 容量 {capacity}</span>}
      <span>
        {" "}
        能力 {verified}
        {capabilities.length > 0 && ` / ${capabilities.length}`}
      </span>{" "}
      <Button
        type="button"
        variant="ghost"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`查看 ${machine.label} 机器详情`}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        详情
      </Button>
    </li>
  );
}
