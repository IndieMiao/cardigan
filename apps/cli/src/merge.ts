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
  canRecheckMerge,
  type EffectivePreMergeCheck,
  effectivePreMergeChecks,
  mergeCheckBlockers,
  mergePlan,
  parseId,
  prepareMergePlan,
  qualifyId,
  recheckMerge,
  recordDecision,
  requestMerge,
  screenshotCheckEnforced,
  setMergeSolo,
  setMergeWindow,
} from "@cardigan/domain";
import {
  GithubBudgetJournal,
  GithubClient,
  GithubDispatchJournal,
  GithubRateLimit,
  loadMergeGateConfig,
  recheckCheckRecovery,
  verifyUndispatched,
} from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { openStore as openCardiganStore, type Store } from "@cardigan/store";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import {
  announceDataDir,
  loadProjectMergeGate,
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
  "  cardigan merge confirm <C-n> [--quote <原话>] [--yes --reason <理由> [--follow-up-actions]]  检查通过后确认；强行确认必须同时提供 --yes 和理由",
  "    未完成的挡合并人工事项会继续挡住合并；--follow-up-actions 把它们一并改为合并后跟进",
  "  cardigan merge hold <C-n> --reason <原因> [--until <带时区时间>] [--quote <原话>]  暂缓合并（到期自动恢复）",
  "  cardigan merge request <C-n>                      旧 hold 之后重新发起合并确认",
  "  cardigan merge finish-undispatched <C-n> <attempt> [--project <p>]  在线核实并收尾未派发的旧检查（仅人）",
  "  cardigan merge recovery-recheck <登记编号> [--project <p>]  显式重查已结束检查的残留登记（仅人）",
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
const BOOLEAN_FLAGS = new Set(["yes", "follow-up-actions"]);
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
    case "solo":
    case "window":
      return mergeOrdering(rest, io, sub);
    case "status":
      return mergeStatus(rest, io);
    case "confirm":
      return mergeConfirm(rest, io, "merge");
    case "hold":
      return mergeConfirm(rest, io, "hold");
    case "request":
      return mergeRequest(rest, io);
    case "finish-undispatched":
      return finishUndispatched(rest, io);
    case "recovery-recheck":
      return mergeRecoveryRecheck(rest, io);
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

async function finishUndispatched(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  const [rawCard, attempt] = positionals;
  const card = cardId(rawCard);
  if (
    positionals.length !== 2 ||
    !attempt ||
    Object.keys(flags).some((f) => !["project", "data-dir"].includes(f))
  )
    throw new CliError("请提供卡片和派发记录的 attempt 编号。", EXIT.usage, [
      USAGE,
    ]);
  const store = open(io, flags);
  try {
    const project = resolveProject(store, io, optional(flags, "project"));
    if (resolveActor(io, project, store).kind !== "human")
      throw new CliError("派发收尾仅限人类操作。", EXIT.usage);
    const projects = store.listProjects();
    const dataDir = resolveDataDir(io, optional(flags, "data-dir"));
    const branches = Object.fromEntries(
      projects.map((p) => [p.id, p.base_branch ?? "main"]),
    );
    const config = await loadMergeGateConfig({
      dataDir,
      projectIds: projects.map((p) => p.id),
      baseBranches: branches,
      env: io.env,
    });
    const branch = branches[project];
    const settings = config.forProject(project);
    const journal = new GithubDispatchJournal(store);
    const intent = journal
      .unfinished()
      .find(
        (i) =>
          i.project === project && i.card === card && i.attempt === attempt,
      );
    const target = intent?.executor && config.forExecutor?.(intent.executor);
    if (
      !branch ||
      !intent ||
      !target ||
      target.type !== "github" ||
      settings.status === "invalid"
    )
      throw new CliError(
        "找不到可核实的 GitHub 派发登记或其原执行器。",
        EXIT.usage,
      );
    try {
      await verifyUndispatched(
        store,
        journal,
        intent,
        settings,
        target,
        branch,
        new GithubClient({
          config: target,
          dataDir,
          rate: new GithubRateLimit(
            target.restBudgetPerHour,
            Date.now,
            new GithubBudgetJournal(store, target.name),
          ),
        }),
      );
    } catch {
      throw new CliError(
        "未能核实该派发已过期且没有匹配的 GitHub 运行，未收尾。",
        EXIT.usage,
      );
    }
    io.stdout(`已核实未派发并释放占用：${card} / ${attempt}`);
    return EXIT.ok;
  } finally {
    store.close();
  }
}

async function mergeRecoveryRecheck(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const parsed = parseArgs(args),
    registration = parsed.positionals[0];
  if (!registration || parsed.positionals.length !== 1)
    throw new CliError("请提供一个恢复登记编号。", EXIT.usage);
  const store = open(io, parsed.flags);
  try {
    const project = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const actor = resolveActor(io, project, store);
    if (actor.kind !== "human")
      throw new CliError("残留登记重查仅限人类操作。", EXIT.usage);
    try {
      recheckCheckRecovery(store, systemClock, actor, project, registration);
    } catch {
      throw new CliError(
        "无法重查该恢复登记，请核对项目与登记编号。",
        EXIT.usage,
      );
    }
    io.stdout("已请求重查残留登记；后台将重新核验原执行目标，不执行删除。");
    return EXIT.ok;
  } finally {
    store.close();
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
        if (!canRecheckMerge(state.events, id, plan.value.completion_id))
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
  // C-674: full numbers (`CDG-C-34`) so the output reads the same anywhere.
  const code = store.projectCode(project_id);
  const full = (id: string) => qualifyId(code, id);
  const lines = [
    `${full(card.id)} ${card.status} merge_policy=${card.merge_policy ?? "confirm"} base=${card.base_branch ?? "无"} — ${card.title}`,
    `  confirmation: ${
      confirmation === undefined
        ? "none"
        : `${full(confirmation.id)} ${confirmation.status}${
            confirmation.resolution === undefined
              ? ""
              : ` (${confirmation.resolution.option})`
          }${
            ["open", "snoozed"].includes(confirmation.status)
              ? confirmation.decider === "role:pm"
                ? " decider=PM（可直接处理）"
                : ` decider=${confirmation.decider}`
              : ""
          }`
    }`,
  ];
  if (confirmation?.status === "snoozed" && confirmation.snooze) {
    const until = new Date(confirmation.snooze.until).toLocaleTimeString(
      "zh-CN",
      { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
    );
    lines.push(`  已暂缓：${confirmation.snooze.reason}（到 ${until}）`);
  }
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
      `  delivery: ${full(delivery.id)} ${full(delivery.work_item_id)} ${delivery.subject.kind}=${delivery.subject.value}`,
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
  return effectivePreMergeChecks(
    card,
    state.work_items,
    state.deliveries,
    screenshotCheckEnforced(state),
  );
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

async function mergeConfirm(
  args: readonly string[],
  io: CliIo,
  option: "merge" | "hold",
): Promise<number> {
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
    const gate = await loadProjectMergeGate(
      store,
      project_id,
      io,
      optional(parsed.flags, "data-dir"),
    );
    const holdReason = optional(parsed.flags, "reason");
    const holdUntil = optional(parsed.flags, "until");
    if (option === "hold" && !holdReason?.trim())
      throw new CliError(
        "暂缓合并必须填写原因：--reason <原因>；可用 --until <带时区时间> 指定到期时间。",
        EXIT.usage,
      );
    const held = confirmation.decider === "role:pm";
    const decision = runCommand(store, {
      operation: option === "merge" ? "确认合并" : "暂不合并",
      target: id,
      project_id,
      actor: resolveActor(io, project_id, store),
      reduce: (state, actor, ports) =>
        recordDecision(
          {
            ...state,
            project_settings: {
              ...state.project_settings,
              ...(gate.status === "enabled" && gate.queue
                ? { merge_queue: { max_batch_size: gate.queue.maxBatchSize } }
                : {}),
              merge_gate_enabled: gate.status !== "disabled",
            },
          },
          actor,
          {
            decision_id: confirmation.id,
            option,
            ...(option === "merge" && parsed.flags.yes === true
              ? {
                  merge_override_reason: holdReason ?? "",
                  ...(parsed.flags["follow-up-actions"] === true
                    ? { merge_override_follow_up: true }
                    : {}),
                }
              : {}),
            rationale:
              option === "merge" ? `命令行确认合并 ${id}` : (holdReason ?? ""),
            ...(holdUntil !== undefined ? { snooze_until: holdUntil } : {}),
            raw_quote:
              optional(parsed.flags, "quote") ??
              `cardigan merge ${option === "merge" ? "confirm" : "hold"} ${id}`,
          },
          ports,
        ),
      clock: systemClock,
    });
    if (decision.resolution?.merge_override)
      io.stdout(
        `已记录强行确认；理由：${decision.resolution.merge_override.reason}；当时缺项：${decision.resolution.merge_override.blockers.join("；") || "无"}`,
      );
    const takeover = held ? "（PM 代确认中，已按你的拍板记录）" : "";
    io.stdout(
      option === "merge"
        ? `已确认合并 ${id}（${decision.id} ${decision.status}）${takeover}；合并循环会把交付合进 ${card.base_branch ?? "无"}。`
        : `已暂缓合并 ${id}（${decision.id}）${takeover}；原因：${decision.snooze?.reason}，到期时间：${decision.snooze?.until}；到期自动放回待处理。`,
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

async function mergeRequest(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
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
    const gate = await loadProjectMergeGate(
      store,
      project_id,
      io,
      optional(parsed.flags, "data-dir"),
    );
    const decision: Decision = runCommand(store, {
      operation: "请求合并",
      target: id,
      project_id,
      actor: resolveActor(io, project_id, store),
      reduce: (state, actor, ports) =>
        requestMerge(
          {
            ...state,
            project_settings: {
              merge_gate_enabled: gate.status !== "disabled",
            },
          },
          actor,
          { card_id: id },
          ports,
        ),
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
      (!["open", "snoozed"].includes(confirmation.status) &&
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

function mergeOrdering(
  args: readonly string[],
  io: CliIo,
  kind: "solo" | "window",
): number {
  const parsed = parseArgs(args),
    id = cardId(parsed.positionals[0]);
  const mode = parsed.positionals[1];
  if (mode !== "on" && mode !== "off")
    throw new CliError("请指定 on 或 off", EXIT.usage);
  const reason =
    optional(parsed.flags, "reason") ??
    (kind === "solo" ? "人在命令行设置" : "");
  const store = open(io, parsed.flags);
  try {
    const project_id = resolveProject(
      store,
      io,
      optional(parsed.flags, "project"),
    );
    const actor = resolveActor(io, project_id, store);
    if (actor.kind !== "human") throw new CliError("只允许人操作", EXIT.usage);
    runCommand<unknown>(store, {
      operation: "调整合并顺序",
      target: id,
      project_id,
      actor,
      reduce: (state, actor, ports) =>
        kind === "solo"
          ? setMergeSolo(
              state,
              actor,
              { card_id: id, solo: mode === "on", reason },
              ports,
            )
          : setMergeWindow(
              state,
              actor,
              { card_id: id, open: mode === "on", reason },
              ports,
            ),
      clock: systemClock,
    });
    io.stdout(`${id} 合并顺序已更新`);
    return EXIT.ok;
  } finally {
    store.close();
  }
}
