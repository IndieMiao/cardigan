import type {
  Actor,
  DeviceEnablementPrompt,
  Event,
  HumanAction,
} from "../entities.js";
import type { HumanActionId } from "../ids.js";
import { transition } from "../transitions.js";
import type { CommandDraft, CommandPorts, CommandState } from "./core.js";
import { command, ensure, unwrap } from "./core.js";

/**
 * C-817: the owner's to-dos about external test devices, written only by the
 * host's machine check and the human-only device commands:
 *
 * - `device-enable:<machine>:<type>:<id>`: a newly discovered device asks
 *   which project to use it for. The person answers through the human-only
 *   machine device endpoint; the action carries the prompt and is updated in
 *   place while the device is initialized, and closed by the system once the
 *   device is enabled (done) or not wanted / gone (cancelled).
 * - `device-unavailable:<machine>:<type>:<id>`: an enabled device became
 *   unusable while queued work of this project needs it. Closed by the
 *   system once the device is back or no work waits on it any more.
 *
 * At most one open action per key. An action a person closed is not reopened
 * for the same key and state (`reopen_key` must change, e.g. a new phase).
 */
const SOURCE = "device_rechecked";
const KEY =
  /^device-(?:enable|unavailable):[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}:[a-z][a-z0-9.-]{0,47}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface DeviceActionOpen {
  readonly instructions: string;
  readonly why_human: string;
  readonly expected_return: string;
  readonly device_enablement?: DeviceEnablementPrompt;
  /** Same value as when a person closed the last action: stay closed. */
  readonly reopen_key: string;
}
export type DeviceActionInput =
  | { readonly key: string; readonly open: DeviceActionOpen }
  | {
      readonly key: string;
      readonly close: {
        readonly outcome: "done" | "cancelled";
        readonly text: string;
      };
    };

const ours = (d: CommandDraft, e: Event) =>
  e.actor.kind === "system" &&
  e.actor.project_id === d.state.project_id &&
  !e.card_id &&
  e.type === "human_action_requested";

/** This key's actions, oldest first, with the reopen key each was raised with. */
function deviceActions(d: CommandDraft, key: string) {
  const actions = new Map(d.list("human_actions").map((h) => [h.id, h]));
  const out: { action: HumanAction; reopen_key: string }[] = [];
  for (const e of d.state.events) {
    if (!ours(d, e)) continue;
    const p = e.payload as {
      human_action_id?: string;
      device_action?: string;
      reopen_key?: string;
    };
    if (p.device_action !== key) continue;
    const action = actions.get(p.human_action_id as HumanActionId);
    if (action?.requested_by !== "system" || action.card_id) continue;
    out.push({ action, reopen_key: p.reopen_key ?? "" });
  }
  return out;
}

function cancel(d: CommandDraft, action: HumanAction, reason: string) {
  d.put("human_actions", {
    ...action,
    status: unwrap(transition("human_action", action.status, "cancel")),
    cancellation: { reason, by: d.author, at: d.now, source: SOURCE },
  });
  d.emit("human_action_cancelled", undefined, {
    human_action_id: action.id,
    reason,
    source: SOURCE,
  });
}

function complete(d: CommandDraft, action: HumanAction, text: string) {
  d.put("human_actions", {
    ...action,
    status: unwrap(transition("human_action", action.status, "complete")),
    result: { text, attachments: [], at: d.now },
  });
  d.emit(
    "human_action_completed",
    undefined,
    { human_action_id: action.id, result: text, resume_work_items: [] },
    { type: "human_action", human_action_id: action.id, body: text },
  );
}

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Internal host machine check / device command only; never an Agent. */
export function reconcileDeviceAction(
  state: CommandState,
  actor: Actor,
  input: DeviceActionInput,
  ports: CommandPorts,
) {
  return command(state, actor, "record_device_action", ports, (d) => {
    ensure(KEY.test(input.key), "validation_failed", "设备待办编号无效");
    const enable = input.key.startsWith("device-enable:");
    if ("open" in input)
      ensure(
        input.open.instructions.trim().length > 0 &&
          input.open.why_human.trim().length > 0 &&
          input.open.expected_return.trim().length > 0 &&
          enable === !!input.open.device_enablement,
        "validation_failed",
        "设备待办内容不完整",
      );
    else
      ensure(
        input.close.text.trim().length > 0,
        "validation_failed",
        "设备待办结项说明不能为空",
      );
    const history = deviceActions(d, input.key);
    const open = history.filter((h) => h.action.status === "open");
    const [current, ...extra] = open;
    for (const h of extra) cancel(d, h.action, `已并入 ${current?.action.id}`);
    if ("close" in input) {
      if (!current) return undefined;
      if (input.close.outcome === "done")
        complete(d, current.action, input.close.text);
      else cancel(d, current.action, input.close.text);
      return current.action.id;
    }
    const { reopen_key, device_enablement, ...fields } = input.open;
    if (current) {
      const a = current.action;
      if (
        a.instructions === fields.instructions &&
        a.why_human === fields.why_human &&
        a.expected_return === fields.expected_return &&
        sameJson(a.device_enablement, device_enablement)
      )
        return a.id;
      const updated: HumanAction = {
        ...a,
        ...fields,
        ...(device_enablement ? { device_enablement } : {}),
      };
      d.put("human_actions", updated);
      d.emit("device_action_updated", undefined, {
        human_action_id: a.id,
        device_action: input.key,
        ...(device_enablement ? { phase: device_enablement.phase } : {}),
      });
      return a.id;
    }
    // Someone else closed it in this same state: do not nag again.
    const last = history.at(-1);
    if (last && last.reopen_key === reopen_key && !closedHere(d, last.action))
      return undefined;
    const id = d.ids.next(d.state.project_id, "human_action");
    d.put("human_actions", {
      id,
      key: id,
      requested_by: "system",
      status: "open",
      category: "general",
      triage: "human",
      ...fields,
      ...(device_enablement ? { device_enablement } : {}),
      blocked_work_items: [],
    });
    d.emit("human_action_requested", undefined, {
      human_action_id: id,
      device_action: input.key,
      reopen_key,
      blocked_work_items: [],
    });
    return id;
  });
}

/** Closed by this command (a system recheck), not by a person or PM. */
function closedHere(d: CommandDraft, action: HumanAction) {
  if (action.status === "cancelled")
    return action.cancellation?.source === SOURCE;
  return d.state.events.some(
    (e) =>
      e.type === "human_action_completed" &&
      e.actor.kind === "system" &&
      (e.payload as { human_action_id?: string }).human_action_id === action.id,
  );
}
