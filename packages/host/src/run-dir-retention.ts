import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AssignmentId,
  type CommandState,
  hostOpsPending,
} from "@cardigan/domain";
import {
  agentProcessCommand,
  type ExecutionConfig,
  executionPaths,
} from "@cardigan/runtime-herdr";

/** C-743 defaults; the host may override them (`CARDIGAN_RUN_DIR_RETENTION_*`). */
export const DEFAULT_RUN_DIR_RETENTION_DAYS = 3;

const helper = new URL("../src/run-dir-retention.py", import.meta.url);
const assignmentName = /^A-[1-9][0-9]*$/u;
const finished = new Set(["completed", "failed", "cancelled"]);

/**
 * Released Assignments whose run directory may go, grouped by machine. Never
 * an active Assignment, an unconfirmed terminal exit (`runtime_ref`), an
 * unfinished Run, pending host operations, an open human action naming its
 * work, or a card PM named for keeping (`keep_run_dirs`).
 */
export function reclaimableRunDirectories(
  s: CommandState,
  days: number,
  now: number,
): Map<string, string[]> {
  const busy = new Set<string>(
    s.runs.filter((r) => !finished.has(r.status)).map((r) => r.assignment_id),
  );
  const runOwner = new Map<string, string>(
    s.runs.map((r) => [r.id, r.assignment_id]),
  );
  const open = new Set<string>(
    s.human_actions.filter((h) => h.status === "open").map((h) => h.id),
  );
  const namedWork = new Set<string>();
  for (const h of s.human_actions) {
    if (!open.has(h.id)) continue;
    for (const w of [
      ...h.blocked_work_items,
      ...(h.follow_up_work_items ?? []),
    ])
      namedWork.add(w);
    if (h.host_assignment_id) busy.add(h.host_assignment_id);
  }
  for (const e of s.events) {
    if (e.type !== "human_action_requested") continue;
    const p = e.payload as {
      human_action_id?: string;
      assignment_id?: string;
      run_id?: string;
      preparation_run_id?: string;
    } | null;
    if (!p?.human_action_id || !open.has(p.human_action_id)) continue;
    if (p.assignment_id) busy.add(p.assignment_id);
    const owner = runOwner.get(p.run_id ?? p.preparation_run_id ?? "");
    if (owner) busy.add(owner);
  }
  const kept = new Set(
    s.cards.filter((c) => c.keep_run_dirs).map((c) => String(c.id)),
  );
  const cardOf = new Map(
    s.work_items.map((w) => [String(w.id), String(w.card_id)]),
  );
  const cutoff = now - days * 86_400_000;
  const out = new Map<string, string[]>();
  for (const a of s.assignments) {
    const released = Date.parse(a.released_at ?? "");
    const work = a.work_item_id ? String(a.work_item_id) : undefined;
    if (
      a.status !== "released" ||
      !assignmentName.test(a.id) ||
      !Number.isFinite(released) ||
      released >= cutoff ||
      a.runtime_ref ||
      busy.has(a.id) ||
      hostOpsPending(s.events, a.id as AssignmentId) ||
      (work !== undefined &&
        (namedWork.has(work) || kept.has(cardOf.get(work) ?? "")))
    )
      continue;
    const list = out.get(a.machine_id) ?? [];
    list.push(a.id);
    out.set(a.machine_id, list);
  }
  return out;
}

export interface RunDirResult {
  readonly name: string;
  readonly state: "removed" | "emptied" | "partial" | "skipped" | "preview";
  readonly freed_bytes: number;
}
export interface RunDirReply {
  readonly results: readonly RunDirResult[];
  readonly complete: boolean;
}
const states = new Set(["removed", "emptied", "partial", "skipped", "preview"]);

function parse(text: string, asked: ReadonlySet<string>): RunDirReply {
  const reply = JSON.parse(text) as RunDirReply;
  if (
    !reply ||
    typeof reply.complete !== "boolean" ||
    !Array.isArray(reply.results) ||
    !reply.results.every(
      (r) =>
        r &&
        Object.keys(r).sort().join() === "freed_bytes,name,state" &&
        typeof r.name === "string" &&
        asked.has(r.name) &&
        states.has(r.state) &&
        Number.isSafeInteger(r.freed_bytes) &&
        r.freed_bytes >= 0,
    ) ||
    new Set(reply.results.map((r) => r.name)).size !== reply.results.length
  )
    throw new Error("Invalid run directory reply");
  return reply;
}

export type RunDirCommand = (
  file: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
) => Promise<string>;
export const executeRunDirCommand: RunDirCommand = (
  file,
  args,
  input,
  timeoutMs,
) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      },
      // Never forward SSH or Python diagnostics: they could name private paths.
      (error, stdout) =>
        error
          ? reject(new Error("Run directory worker unavailable"))
          : resolve(stdout),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

/**
 * Remove the named run directories on one machine. The removal runs as the
 * account that wrote them (the Agent account through its SSH path); on the
 * control host's own agent machine the host account then removes what it
 * owns, including the protected leaf itself.
 */
export async function reclaimRunDirectories(
  execution: ExecutionConfig,
  project: string,
  names: readonly string[],
  options: {
    readonly budgetMs?: number;
    readonly preview?: boolean;
    /** The leaf's parent is host-owned: true for the control host's machine. */
    readonly hostOwnsParent?: boolean;
    readonly run?: RunDirCommand;
    /** Tests only: how the Agent account's command line is built. */
    readonly agentCommand?: typeof agentProcessCommand;
  } = {},
): Promise<RunDirReply> {
  const valid = names.filter((n) => assignmentName.test(n));
  if (!valid.length) return { results: [], complete: true };
  const root = dirname(
    executionPaths(execution, project, valid[0] ?? "").runDir,
  );
  const budget = options.budgetMs ?? 60_000;
  const run = options.run ?? executeRunDirCommand;
  const source = readFileSync(helper, "utf8");
  const request = (subset: readonly string[]) =>
    JSON.stringify({
      root,
      names: subset,
      budget_ms: budget,
      preview: options.preview === true,
    });
  const local = async (subset: readonly string[]) =>
    parse(
      await run(
        "/usr/bin/python3",
        ["-I", "-B", "-c", source],
        request(subset),
        budget + 30_000,
      ),
      new Set(subset),
    );
  if (execution.mode !== "agent-ssh") return local(valid);
  const command = await (options.agentCommand ?? agentProcessCommand)(
    execution,
    [
      execution.fileHelper?.python ?? "/usr/bin/python3",
      "-I",
      "-B",
      "-c",
      source,
    ],
  );
  const first = parse(
    await run(command.file, command.args, request(valid), budget + 30_000),
    new Set(valid),
  );
  if (!options.hostOwnsParent || options.preview) return first;
  // Host-written launch files and the 2770 leaf itself belong to the host.
  const rest = first.results
    .filter((r) => r.state === "emptied" || r.state === "partial")
    .map((r) => r.name);
  if (!rest.length) return first;
  const second = new Map(
    (await local(rest)).results.map((r) => [r.name, r] as const),
  );
  const results = await Promise.all(
    first.results.map(async (r): Promise<RunDirResult> => {
      const again = second.get(r.name);
      if (!again) return r;
      const freed_bytes = r.freed_bytes + again.freed_bytes;
      if (again.state === "emptied")
        try {
          await rmdir(`${root}/${r.name}`);
          return { name: r.name, state: "removed", freed_bytes };
        } catch {
          return { name: r.name, state: "emptied", freed_bytes };
        }
      return { name: r.name, state: again.state, freed_bytes };
    }),
  );
  return { results, complete: first.complete };
}
