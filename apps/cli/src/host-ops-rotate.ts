import {
  type Assignment,
  finishHostOpsRotation,
  type ProjectId,
  prepareHostOpsRotation,
} from "@cardigan/domain";
import {
  RuntimeTargets,
  scrubRunCredentials,
  stopRunRuntime,
  tryHostOpsLock,
} from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { secureDataDirectory } from "@cardigan/runtime-herdr";
import {
  finishBellAttempt,
  reassignNotifications,
  type Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import { resolveActor, systemClock } from "./host.js";
import type { CliIo } from "./io.js";
import { launchExecution, terminalExecution } from "./runtime-check.js";

/** Stop is confirmed before atomically replacing the identity, credentials and inbox. */
export async function rotateHostOps(input: {
  store: Store;
  io: CliIo;
  project_id: ProjectId;
  dataDir: string;
  session?: string;
}): Promise<Assignment> {
  const { store, io, project_id, dataDir } = input;
  const actor = resolveActor(io, project_id, store);
  // Refuse a mismatched launch shell before touching the on-duty identity.
  await launchExecution(io, dataDir, input.session);
  const current = store.uow.read((tx) =>
    tx.assignments
      .list(project_id)
      .filter((a) => a.role_id === "host_ops" && a.status !== "released"),
  );
  const previous = current[0];
  if (current.length !== 1 || !previous)
    throw new CliError("需要恰好一个常驻主机运维 Assignment", EXIT.usage);
  const unlock = await tryHostOpsLock(store, project_id, previous.id);
  if (!unlock)
    throw new CliError("主机运维正在被另一操作处理，请稍后重试", EXIT.failure);
  try {
    const { execution, session } = await terminalExecution(
      io,
      dataDir,
      previous.runtime_ref,
      previous.id,
      input.session,
      { store, project: project_id },
    );
    await secureDataDirectory(execution);
    // No new terminal is needed when the old Assignment was never started.
    const created = previous.runtime_ref
      ? await RuntimeTargets.create({
          execution,
          session,
          env: io.env,
          store,
          project: project_id,
        })
      : undefined;
    if (created && !created.ok)
      throw new CliError("无法连接旧终端的运行时，未开始轮换", EXIT.failure);
    const begun = store.uow.read((tx) => {
      const result = prepareHostOpsRotation(
        loadCommandState(tx, project_id),
        actor,
      );
      if (!result.ok)
        throw new CliError(
          formatCommandError("轮换主机运维", previous.id, result.error),
          EXIT.usage,
        );
      if (
        JSON.stringify(result.value.data.previous) !== JSON.stringify(previous)
      )
        throw new CliError(
          "主机运维状态已改变，请重新运行 rotate",
          EXIT.failure,
        );
      return result.value.data;
    });
    if (begun.unchanged) {
      io.stdout(`主机运维 ${previous.id} 已是最新版本，继续检查启动状态。`);
      return previous;
    }
    const currentTarget = () =>
      store.uow.read((tx) => {
        const a = tx.assignments.get(project_id, previous.id);
        return (
          a?.status === "active" &&
          JSON.stringify(a.runtime_ref) === JSON.stringify(previous.runtime_ref)
        );
      });
    if (
      created?.ok &&
      (await stopRunRuntime(
        created.value,
        previous.runtime_ref,
        currentTarget,
      )) !== "exited"
    )
      throw new CliError(
        "旧终端尚未确认退出，未改动旧身份、凭据或待处理事项；请核实后重试 host-ops rotate",
        EXIT.failure,
      );
    if (!currentTarget())
      throw new CliError("轮换对象已改变，请核对最新状态", EXIT.failure);
    const next = store.uow.run((tx) => {
      const current = tx.assignments.get(project_id, previous.id);
      if (
        current?.status !== "active" ||
        JSON.stringify(current.runtime_ref) !==
          JSON.stringify(previous.runtime_ref)
      )
        throw new CliError("轮换对象已改变", EXIT.failure);
      const result = finishHostOpsRotation(
        loadCommandState(tx, project_id),
        actor,
        { previous_assignment_id: previous.id, to_version: begun.to_version },
        { clock: systemClock, ids: tx.ids },
      );
      if (!result.ok)
        throw new CliError(
          formatCommandError("完成主机运维轮换", previous.id, result.error),
          EXIT.failure,
        );
      persistEffect(tx, project_id, result.value);
      for (const token of tx.tokensForAssignment(project_id, previous.id))
        if (token.revoked_at === null && !tx.revokeToken(token.id))
          throw new CliError("撤销旧凭据失败", EXIT.failure);
      for (const attempt of unfinishedBellAttempts(store.database, project_id))
        if (attempt.assignment_id === previous.id)
          finishBellAttempt(
            store.database,
            project_id,
            attempt.id,
            "failed",
            new Date(
              Math.max(Date.now(), Date.parse(attempt.started_at)),
            ).toISOString(),
          );

      reassignNotifications(store.database, {
        project_id,
        from: previous.id,
        to: result.value.data.assignment.id,
        run_ids: tx.runs
          .list(project_id)
          .filter((r) => r.assignment_id === previous.id)
          .map((r) => r.id),
        at: systemClock.now(),
      });
      return result.value.data.assignment;
    });
    try {
      await scrubRunCredentials(execution, project_id, previous.id);
    } catch {
      io.stderr(
        `旧终端已退出、旧凭据已撤销，但运行目录凭据清理失败；请核对 ${previous.id} 的运行目录。新身份为 ${next.id}。`,
      );
    }
    io.stdout(
      `已将主机运维 ${previous.id}（v${previous.role_version}）轮换为 ${next.id}（v${next.role_version}），保留员工并转交待处理通知；旧身份已释放。`,
    );
    return next;
  } finally {
    await unlock();
  }
}
