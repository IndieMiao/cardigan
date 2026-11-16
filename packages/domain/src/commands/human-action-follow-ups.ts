import type { Actor } from "../entities.js";
import { isMergePrerequisite } from "../human-action.js";
import { type CommandPorts, type CommandState, command } from "./core.js";
import { queueResumedRun, resumeWork } from "./resumption.js";

/** Old field checks become follow-ups without completing the human's outstanding action. */
export function refreshHumanActionFollowUps(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(
    state,
    actor,
    "refresh_human_action_follow_ups",
    ports,
    (d) => {
      for (const action of d.list("human_actions")) {
        if (
          action.status !== "open" ||
          isMergePrerequisite(action) ||
          !action.blocked_work_items.length
        )
          continue;
        d.put("human_actions", {
          ...action,
          blocks_merge: false,
          blocked_work_items: [],
          follow_up_work_items: [
            ...new Set([
              ...(action.follow_up_work_items ?? []),
              ...action.blocked_work_items,
            ]),
          ],
          ...(!action.ready_when && action.card_id
            ? {
                ready_when: {
                  kind: "card_merged" as const,
                  card_id: action.card_id,
                },
              }
            : {}),
        });
        const resumed = action.blocked_work_items.flatMap((id) => {
          const item = d.list("work_items").find((w) => w.id === id);
          if (
            !item ||
            ["done", "cancelled"].includes(d.get("cards", item.card_id).status)
          )
            return [];
          const result = resumeWork(d, item);
          return result ? [result] : [];
        });
        const event = d.emit(
          "human_action_follow_up",
          action.card_id,
          {
            human_action_id: action.id,
            previous_blocked_work_items: [...action.blocked_work_items],
            resume_work_items: resumed.map((w) => w.id),
          },
          {
            type: "system",
            body: `${action.id} 已改为合并后跟进，保留待办和原请求，不再阻塞工作或合并。`,
            human_action_id: action.id,
          },
        );
        for (const item of resumed) queueResumedRun(d, item, event);
      }
    },
  );
}
