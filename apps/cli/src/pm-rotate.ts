import type {
  Actor,
  ProjectId,
  RotateStandingPmResult,
  StandingMode,
} from "@cardigan/domain";
import { rotateStandingPm, standingTools } from "@cardigan/domain";
import { persistPmRotation } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  backfillStandingModesInTransaction,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import {
  issueTokenForAssignment,
  printToken,
  roleInTransaction,
  systemClock,
  warmCommandState,
} from "./host.js";
import type { CliIo } from "./io.js";

const LABEL = { ops: "PM Ops", office: "PM Office" } as const;

export interface RotateOptions {
  readonly actor?: Actor;
  readonly external?: boolean;
  readonly employee_id?: string;
  /** Test seam: runs last inside the write transaction. */
  readonly beforeCommit?: (tx: StoreTransactionContext) => void;
}

/**
 * `cardigan pm rotate`: the domain effect, the old tokens, the router inbox
 * and unfinished bell attempts change in one write transaction, or not at all.
 */
export function rotateStandingPmInStore(
  store: Store,
  project_id: ProjectId,
  standing_mode: StandingMode,
  options: RotateOptions = {},
): RotateStandingPmResult & {
  readonly revoked_tokens: number;
  readonly token?: ReturnType<typeof issueTokenForAssignment>;
} {
  warmCommandState(store, project_id);
  return store.uow.run((tx) => {
    backfillStandingModesInTransaction(tx, project_id);
    const at = systemClock.now();
    const result = rotateStandingPm(
      loadCommandState(tx, project_id),
      options.actor ?? { kind: "human", project_id },
      {
        standing_mode,
        ...(options.external === undefined
          ? {}
          : { external: options.external }),
        ...(options.employee_id === undefined
          ? {}
          : { employee_id: options.employee_id }),
      },
      { clock: systemClock, ids: tx.ids },
    );
    if (!result.ok)
      throw new CliError(
        formatCommandError(
          "给常驻 PM 换版本",
          LABEL[standing_mode],
          result.error,
        ),
        EXIT.usage,
      );
    const data = result.value.data;
    if (data.unchanged) return { ...data, revoked_tokens: 0 };
    const revoked_tokens = persistPmRotation(
      store,
      tx,
      project_id,
      result.value,
      at,
    );
    const token = data.assignment.external
      ? issueTokenForAssignment(tx, project_id, data.assignment.id, {
          role_version: data.assignment.role_version,
          allowed_tools: standingTools(
            roleInTransaction(
              tx,
              project_id,
              "pm",
              data.assignment.role_version,
            ).allowed_tools,
            standing_mode,
          ),
        })
      : undefined;
    options.beforeCommit?.(tx);
    return { ...data, revoked_tokens, ...(token ? { token } : {}) };
  });
}

export function printRotation(
  io: CliIo,
  mode: StandingMode,
  result: ReturnType<typeof rotateStandingPmInStore>,
): void {
  const label = LABEL[mode];
  if (result.unchanged) {
    io.stdout(
      `${label}（${result.assignment.id}）已是最新版本 pm v${result.to_version}，没有改动。只想换个新会话请用 cardigan pm restart --${mode}（不暂停、不转交事项）`,
    );
    return;
  }
  io.stdout(
    [
      `已把 ${label} 从 ${result.previous.id}（pm v${result.from_version}）换到 ${result.assignment.id}（pm v${result.to_version}）`,
      `转给新 Assignment 的待处理事项：拍板 ${result.decisions.length} 项，待你执行 ${result.human_actions.length} 项；没有事项转回给人`,
      `旧 Assignment ${result.previous.id} 已释放，作废 Token ${result.revoked_tokens} 个${result.cancelled_run_ids.length ? `，取消未结束的 Run：${result.cancelled_run_ids.join(", ")}` : ""}`,
      "旧会话的终端由 cardigan server 的清理循环自动关闭；server 没在运行时，旧终端会留着但已无法读写项目，可在 Herdr 里手动关闭。",
      result.assignment.external
        ? "外接身份，由对接的 Agent 自行拉取；用 cardigan inbox 查看待处理通知。"
        : `启动新的 ${label}：cardigan assignment start ${result.assignment.id}`,
    ].join("\n"),
  );
  if (result.token) printToken(io, result.token);
}
