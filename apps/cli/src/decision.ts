import {
  DECISION_OTHER_OPTION,
  parseId,
  recordDecision,
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

const USAGE =
  '用法：cardigan decision answer <Q-n> --other "你的决定" [--project <项目>] [--data-dir <目录>]';

/**
 * C-682: answer any pending decision with "其他" and the human's own words.
 * Preset options keep their dedicated commands (merge, rework, worktree).
 */
export async function runDecisionCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const [sub, target, ...rest] = args;
  if (sub !== "answer" || !target || rest.length % 2)
    throw new CliError(USAGE, EXIT.usage);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i] as string,
      value = rest[i + 1] as string;
    if (!["--project", "--data-dir", "--other"].includes(key) || flags.has(key))
      throw new CliError("选项无效或重复。", EXIT.usage, [USAGE]);
    flags.set(key, value);
  }
  const words = flags.get("--other")?.trim();
  if (!words)
    throw new CliError(
      "选“其他”时必须填写说明：--other <你的决定>",
      EXIT.usage,
      [USAGE],
    );
  const id = parseId("decision", target);
  if (!id.ok) throw new CliError("拍板编号不合法。", EXIT.usage);
  const decision_id = id.value.id;
  const store = openStore({
    dataDir: announceDataDir(io, flags.get("--data-dir")),
  });
  try {
    const project_id = resolveProject(store, io, flags.get("--project"));
    const actor = resolveActor(io, project_id, store);
    if (actor.kind !== "human")
      throw new CliError("“其他”只能由人亲自填写。", EXIT.usage);
    runCommand(store, {
      operation: "以“其他”回答拍板",
      target,
      project_id,
      actor,
      reduce: (state, caller, ports) =>
        recordDecision(
          state,
          caller,
          {
            decision_id,
            option: DECISION_OTHER_OPTION,
            rationale: words,
            raw_quote: words,
          },
          ports,
        ),
    });
    io.stdout(`${decision_id}：已按“其他”结项，原话已交发起方跟进。`);
    return EXIT.ok;
  } finally {
    store.close();
  }
}
