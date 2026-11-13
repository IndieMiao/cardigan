import type {
  Card,
  CardId,
  Decision,
  HumanActionId,
  ProjectId,
} from "@cardigan/domain";
import {
  acceptMergePushHold,
  type CommandState,
  type EffectivePreMergeCheck,
  effectivePreMergeChecks,
  latestMergeCheck,
  mergeCheckBlockers,
  mergePlan,
  parseId,
  prepareMergePlan,
  recheckMerge,
  recordDecision,
  requestMerge,
} from "@cardigan/domain";
import { loadMergeGateConfig } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { openStore as openCardiganStore, type Store } from "@cardigan/store";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import {
  announceDataDir,
  resolveActor,
  resolveDataDir,
  resolveProject,
  runCommand,
  systemClock,
} from "./host.js";
import type { CliIo } from "./io.js";
import { CLI_PRE_MERGE_COPY as COPY } from "./pre-merge-copy.js";

/**
 * M4.4 merge commands (plan §4 M4.4, development plan §12.5).
 *
 * The human is the only actor allowed to confirm a merge; the confirmation is
 * recorded as a normal Decision so the merge loop and the audit trail see the
 * same thing, with the command line preserved as the raw quote.
 */
const USAGE = [
  "用法：",
  "  cardigan merge status [C-n] [--project <p>]       看待合并的卡片、确认和合并计划",
  "  cardigan merge confirm <C-n> [--quote <原话>] [--yes]  以人的身份确认合并；合并前核对未完成时须加 --yes",
  "  cardigan merge hold <C-n> [--quote <原话>]        以人的身份暂不合并",
  "  cardigan merge request <C-n>                      hold 之后重新发起合并确认",
  "  cardigan merge recheck <C-n> [--project <p>]       重查失败或超时的合并候选",
  "  cardigan merge request-changes <C-n> --reason <原因> [--project <p>]  退回修改（原因必填）",
  "  cardigan merge push-accept <H-n> --text <说明> [--project <p>]  确认接受暂停推送里列出的外来提交并恢复自动推送",
  "",
  "PM 代确认中的合并也可以直接 confirm、hold 或 request-changes，按你的拍板记录。",
  "通用：--project 省略时取 CARDIGAN_PROJECT，再取数据库里唯一的项目；",
  "      --data-dir 省略时取 CARDIGAN_DATA_DIR，再取 ~/.local/share/cardigan。",
].join("\n");

interface Args {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}
const BOOLEAN_FLAGS = new Set(["yes"]);
function parseArgs(args: readonly string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2) as [string, string?];
    if (BOOLEAN_FLAGS.has(name) && inline === undefined) {
      flags[name] = true;
      continue;
    }
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new CliError(`${token} 需要一个值`, EXIT.usage, [USAGE]);
    flags[name] = value;
    index += 1;
  }
  return { positionals, flags };
}
const optional = (flags: Args["flags"], name: string): string | undefined => {
  const value = flags[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};
function cardId(raw: string | undefined): CardId {
  const parsed = parseId("card", raw);
  if (!parsed.ok)
    throw new CliError(`卡片编号不合法：${JSON.stringify(raw)}`, EXIT.usage, [
      USAGE,
    ]);
  return parsed.value.id;
}
function open(io: CliIo, flags: Args["flags"]): Store {
  return openCardiganStore({
    dataDir: announceDataDir(io, optional(flags, "data-dir")),
  });
}

export async function runMergeCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "status":
      return mergeStatus(rest, io);
    case "confirm":
      return mergeConfirm(rest, io, "merge");
    case "hold":
      return mergeConfirm(rest, io, "hold");
    case "request":
      return mergeRequest(rest, io);
    case "recheck":
      return mergeRecheck(rest, io);
    case "request-changes":
      return mergeRequestChanges(rest, io);
    case "push-accept":
      return mergePushAccept(rest, io);
    default:
      throw new CliError(
        "用法：cardigan merge status|confirm|hold|request|request-changes|recheck|push-accept",
        EXIT.usage,
        [USAGE],
      );
  }
}

async function mergeRecheck(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs(args),
    id = cardId(parsed.positionals[0]),
    store = open(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    requireMergeCard(store, project_id, id);
    const config = await loadMergeGateConfig({
      dataDir: resolveDataDir(io, optional(parsed.flags, "data-dir")),
      baseBranches: Object.fromEntries(
        store.listProjects().map((p) => [p.id, p.base_branch ?? "main"]),
      ),
      projectIds: store.listProjects().map((project) => project.id),
      env: io.env,
    });
    const gate = config.forProject(project_id);
    if (gate.status !== "enabled")
      throw new CliError(
        gate.status === "invalid" ? gate.reason : "该项目未启用合并闸门",
        EXIT.usage,
      );
    runCommand(store, {
      operation: "重新检查合并",
      target: id,
      project_id,
      actor: resolveActor(io, project_id, store),
      clock: systemClock,
      reduce: (state, actor, ports) => {
        const plan = prepareMergePlan(state, id);
        if (!plan.ok)
          throw new CliError(
            formatCommandError("重新检查合并", id, {
              ...plan.error,
              message: "请确认当前完成申请已通过审核，且没有待处理的阻塞事项。",
            }),
            EXIT.usage,
          );
        const latest = latestMergeCheck(
          state.events,
          id,
          plan.value.completion_id,
        );
        if (!latest || !["failed", "timed_out"].includes(latest.status))
          throw new CliError(
            `${id} 当前完成申请没有失败或超时的检查结果，不能重新检查。`,
            EXIT.usage,
          );
        return recheckMerge(
          { ...state, project_settings: { merge_gate_enabled: true } },
          actor,
          { card_id: id },
          ports,
        );
      },
    });
    io.stdout(`已将 ${id} 的合并候选重新排队检查。`);
    return EXIT.ok;
  } finally {
    store.close();
  }
}

/** The merge confirmation of a card that is still usable (open or resolved). */
function confirmationOf(store: Store, project_id: ProjectId, card_id: CardId) {
  return store.uow.read((tx) =>
    tx.decisions
      .list(project_id)
      .filter(
        (decision) =>
          decision.trigger === "merge_confirmation" &&
          decision.card_id === card_id &&
          decision.status !== "superseded",
      )
      .at(-1),
  );
}

function mergeStatus(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args);
  const store = open(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const wanted = parsed.positionals[0];
    const cards = store.uow.read((tx) =>
      tx.cards
        .list(project_id)
        .filter(
          (card) =>
            card.status === "awaiting_merge" &&
            (wanted === undefined || card.id === wanted),
        )
        .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2))),
    );
    if (cards.length === 0) {
      io.stdout(
        wanted === undefined
          ? "没有待合并的卡片。"
          : `${wanted} 不在待合并状态。`,
      );
      return EXIT.ok;
    }
    const lines: string[] = [];
    for (const card of cards) lines.push(...describe(store, project_id, card));
    io.stdout(lines.join("\n"));
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function describe(
  store: Store,
  project_id: ProjectId,
  card: Card,
): readonly string[] {
  // The same snapshot the commands see, so `mergePlan` can be trusted here.
  const state = store.uow.read((tx) => loadCommandState(tx, project_id));
  const confirmation = state.decisions
    .filter(
      (decision) =>
        decision.trigger === "merge_confirmation" &&
        decision.card_id === card.id,
    )
    .at(-1);
  const plan = mergePlan(state, card.id);
  const lines = [
    `${card.id} ${card.status} merge_policy=${card.merge_policy ?? "confirm"} base=${card.base_branch ?? "无"} — ${card.title}`,
    `  confirmation: ${
      confirmation === undefined
        ? "none"
        : `${confirmation.id} ${confirmation.status}${
            confirmation.resolution === undefined
              ? ""
              : ` (${confirmation.resolution.option})`
          }${
            confirmation.status === "open"
              ? confirmation.decider === "role:pm"
                ? " decider=PM（可直接处理）"
                : " decider=human"
              : ""
          }`
    }`,
  ];
  const accepted = state.deliveries.filter(
    (delivery) =>
      delivery.kind !== "card_completion" &&
      delivery.status === "accepted" &&
      state.work_items.some(
        (item) => item.id === delivery.work_item_id && item.card_id === card.id,
      ),
  );
  for (const delivery of accepted)
    lines.push(
      `  delivery: ${delivery.id} ${delivery.work_item_id} ${delivery.subject.kind}=${delivery.subject.value}`,
    );
  lines.push(...preMergeLines(preMergeChecksOf(state, card)));
  for (const blocker of mergeCheckBlockers(state, card.id)) {
    const since = new Date(blocker.started_at).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    lines.push(
      `  合并检查未开始：被 ${blocker.label} 挡住（自 ${since} 起）：${blocker.detail}`,
    );
  }
  lines.push(
    plan.ok
      ? `  plan: ready (completion ${plan.value.completion_id}, ${plan.value.deliveries.length} deliveries)`
      : `  plan: not ready — ${formatCommandError("生成合并计划", card.id, plan.error)}`,
  );
  return lines;
}

/** C-160: the card's pre-merge checks, read as the Workbench reads them. */
function preMergeChecksOf(
  state: CommandState,
  card: Card,
): readonly EffectivePreMergeCheck[] {
  return effectivePreMergeChecks(card, state.work_items, state.deliveries);
}
const openChecks = (checks: readonly EffectivePreMergeCheck[]) =>
  checks.filter((c) => c.status !== "passed");
function checkLine(c: EffectivePreMergeCheck): string {
  return `    - ${c.label}：${COPY.status[c.status]}${
    c.stale ? `（${COPY.staleNote}）` : ""
  }${c.note ? `（${c.note}）` : ""}`;
}
function preMergeLines(
  checks: readonly EffectivePreMergeCheck[],
): readonly string[] {
  if (checks.length === 0) return [];
  const open = openChecks(checks);
  return [
    `  ${COPY.statusHeading}${
      open.length > 0
        ? `!! ${COPY.waitingTitle(open.map((c) => c.label))}`
        : COPY.readyTitle
    }`,
    ...(open.length > 0 ? open : checks).map(checkLine),
  ];
}

function mergeConfirm(
  args: readonly string[],
  io: CliIo,
  option: "merge" | "hold",
): number {
  const parsed = parseArgs(args);
  const id = cardId(parsed.positionals[0]);
  const store = open(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const card = requireMergeCard(store, project_id, id);
    const confirmation = confirmationOf(store, project_id, card.id);
    if (confirmation === undefined)
      throw new CliError(
        `${id} 没有合并确认（merge_policy 可能是 auto），不需要确认`,
        EXIT.usage,
      );
    if (confirmation.status === "resolved") {
      io.stdout(
        confirmation.resolution?.option === "merge"
          ? `${id} 的合并已经确认过了（${confirmation.id}），等待合并循环执行。`
          : `${id} 的合并被 hold 了（${confirmation.id}）；先运行 cardigan merge request ${id}`,
      );
      return EXIT.ok;
    }
    // C-160: advisory only — never changes who may confirm, but the human
    // must acknowledge unfinished pre-merge checks with --yes.
    const open =
      option === "merge"
        ? openChecks(
            preMergeChecksOf(
              store.uow.read((tx) => loadCommandState(tx, project_id)),
              card,
            ),
          )
        : [];
    if (open.length > 0 && parsed.flags.yes !== true)
      throw new CliError(`!! ${COPY.confirmTitle(open.length)}`, EXIT.usage, [
        ...open.map(checkLine),
        COPY.confirmHint,
        COPY.confirmNeedsYes(`cardigan merge confirm ${id}`),
      ]);
    const held = confirmation.decider === "role:pm";
    const decision = runCommand(store, {
      operation: option === "merge" ? "确认合并" : "暂不合并",
      target: id,
      project_id,
      actor: resolveActor(io, project_id, store),
      reduce: (state, actor, ports) =>
        recordDecision(
          state,
          actor,
          {
            decision_id: confirmation.id,
            option,
            rationale:
              option === "merge"
                ? `命令行确认合并 ${id}`
                : `命令行暂不合并 ${id}`,
            raw_quote:
              optional(parsed.flags, "quote") ??
              `cardigan merge ${option === "merge" ? "confirm" : "hold"} ${id}`,
          },
          ports,
        ),
      clock: systemClock,
    });
    if (open.length > 0) io.stdout(`!! ${COPY.confirmedAnyway(open.length)}`);
    const takeover = held ? "（PM 代确认中，已按你的拍板记录）" : "";
    io.stdout(
      option === "merge"
        ? `已确认合并 ${id}（${decision.id} ${decision.status}）${takeover}；合并循环会把交付合进 ${card.base_branch ?? "无"}。`
        : `已暂不合并 ${id}（${decision.id}）${takeover}；需要时运行 cardigan merge request ${id}`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

/** C-94: the human accepts the listed foreign commits; reverting uses human-action done. */
function mergePushAccept(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args);
  const raw = parsed.positionals[0];
  const id = parseId("human_action", raw);
  if (!id.ok)
    throw new CliError(
      `HumanAction 编号不合法：${JSON.stringify(raw)}（形如 H-3）`,
      EXIT.usage,
      [USAGE],
    );
  const text = optional(parsed.flags, "text");
  if (!text)
    throw new CliError("确认接受必须提供非空的 --text", EXIT.usage, [USAGE]);
  const human_action_id: HumanActionId = id.value.id;
  const store = open(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    runCommand(store, {
      operation: "接受外来提交并恢复推送",
      target: human_action_id,
      project_id,
      actor: resolveActor(io, project_id, store),
      clock: systemClock,
      reduce: (state, actor, ports) =>
        acceptMergePushHold(state, actor, { human_action_id, text }, ports),
    });
    io.stdout(
      `已接受 ${human_action_id} 列出的外来提交；自动推送会在下一轮恢复。`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function mergeRequest(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args);
  const id = cardId(parsed.positionals[0]);
  const store = open(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    requireMergeCard(store, project_id, id);
    const decision: Decision = runCommand(store, {
      operation: "请求合并",
      target: id,
      project_id,
      actor: resolveActor(io, project_id, store),
      reduce: (state, actor, ports) =>
        requestMerge(state, actor, { card_id: id }, ports),
      clock: systemClock,
    });
    io.stdout(`已重新发起 ${id} 的合并确认：${decision.id}（等待确认）`);
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function mergeRequestChanges(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args);
  const id = cardId(parsed.positionals[0]);
  const reason = optional(parsed.flags, "reason");
  if (!reason)
    throw new CliError("退回修改必须提供非空的 --reason", EXIT.usage, [USAGE]);
  const store = open(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    requireMergeCard(store, project_id, id);
    const confirmation = confirmationOf(store, project_id, id);
    if (
      !confirmation ||
      (confirmation.status !== "open" &&
        !(
          confirmation.status === "resolved" &&
          confirmation.resolution?.option === "merge"
        ))
    )
      throw new CliError(
        `${id} 没有待处理的合并确认；hold 后请先运行 cardigan merge request ${id}`,
        EXIT.usage,
      );
    const decision = runCommand(store, {
      operation: "退回修改",
      target: id,
      project_id,
      actor: resolveActor(io, project_id, store),
      reduce: (state, actor, ports) =>
        recordDecision(
          state,
          actor,
          {
            decision_id: confirmation.id,
            option: "request_changes",
            rationale: reason,
            raw_quote: reason,
          },
          ports,
        ),
      clock: systemClock,
    });
    io.stdout(`已将 ${id} 退回修改（${decision.id}）：${reason}`);
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function requireMergeCard(
  store: Store,
  project_id: ProjectId,
  id: CardId,
): Card {
  const card = store.uow.read((tx) => tx.cards.get(project_id, id));
  if (card === undefined) throw new CliError(`${id} 不存在`, EXIT.usage);
  if (card.status !== "awaiting_merge")
    throw new CliError(
      `${id} 当前状态是 ${card.status}，只有 awaiting_merge 才能确认、退回修改、重新发起合并或重新检查`,
      EXIT.usage,
    );
  return card;
}
