import {
  parseId,
  recordDecision,
  requestDeliveryRework,
} from "@cardigan/domain";
import { openStore } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import {
  announceDataDir,
  resolveActor,
  resolveProject,
  runCommand,
} from "./host.js";
import type { CliIo } from "./io.js";

export async function runReworkCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const [sub, target, ...rest] = args;
  if (
    !["request", "confirm", "keep"].includes(sub ?? "") ||
    !target ||
    rest.length % 2
  )
    throw new CliError(
      "用法：cardigan rework request <W-n> --delivery <D-n> --sha <完整提交> --review <V-n> --reason <理由>；rework confirm|keep <Q-n> --reason <理由>",
      EXIT.usage,
    );
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i] as string,
      value = rest[i + 1] as string;
    if (
      ![
        "--project",
        "--data-dir",
        "--delivery",
        "--sha",
        "--review",
        "--reason",
      ].includes(key) ||
      flags.has(key) ||
      !value.trim()
    )
      throw new CliError("选项无效或重复。", EXIT.usage);
    flags.set(key, value);
  }
  const required = (key: string) => {
    const value = flags.get(key);
    if (!value) throw new CliError(`缺少 ${key}`, EXIT.usage);
    return value;
  };
  const parsed = <K extends "work_item" | "delivery" | "review" | "decision">(
    kind: K,
    raw: string,
  ) => {
    const result = parseId(kind, raw);
    if (!result.ok) throw new CliError("编号不合法。", EXIT.usage);
    return result.value.id;
  };
  const rationale = required("--reason");
  const store = openStore({
    dataDir: announceDataDir(io, flags.get("--data-dir")),
  });
  try {
    const project_id = resolveProject(store, io, flags.get("--project"));
    const actor = resolveActor(io, project_id, store);
    if (sub !== "request" && actor.kind !== "human")
      throw new CliError("返工决定必须由人亲自确认。", EXIT.usage);
    if (sub === "request") {
      const params = {
        work_item_id: parsed("work_item", target),
        delivery_id: parsed("delivery", required("--delivery")),
        target_sha: required("--sha"),
        review_id: parsed("review", required("--review")),
        rationale,
      };
      const q = runCommand(store, {
        operation: "请求正式返工",
        target,
        project_id,
        actor,
        reduce: (state, caller, ports) =>
          requestDeliveryRework(state, caller, params, ports),
      });
      io.stdout(`${q.id}：已请求本人确认，尚未退回产出。`);
    } else {
      const decision_id = parsed("decision", target);
      const q = store.uow.read((tx) =>
        tx.decisions.get(project_id, decision_id),
      );
      if (q?.trigger !== "accepted_delivery_rework")
        throw new CliError("只能确认正式返工请求。", EXIT.usage);
      runCommand(store, {
        operation: "回答正式返工请求",
        target,
        project_id,
        actor,
        reduce: (state, caller, ports) =>
          recordDecision(
            state,
            caller,
            {
              decision_id,
              option: sub === "confirm" ? "return_for_rework" : "keep",
              rationale,
              raw_quote: rationale,
            },
            ports,
          ),
      });
      io.stdout(
        sub === "confirm" ? "已正式退回作者修改。" : "已保留当前产出。",
      );
    }
    return EXIT.ok;
  } finally {
    store.close();
  }
}
