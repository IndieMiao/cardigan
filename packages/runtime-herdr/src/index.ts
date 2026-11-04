import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Assignment,
  Machine,
  Role,
  Runtime,
  RuntimeLaunch,
  RuntimeObservation,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
import { fail, type HcClient, processClient, result } from "./client.js";

export interface HerdrOptions {
  readonly binary?: string;
  readonly session?: string;
  readonly socketPath?: string;
  readonly version?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: HcClient;
}
export interface RuntimeEvent {
  readonly seq: number;
  readonly type: string;
  readonly terminal_ref?: string;
  readonly data?: unknown;
  readonly observations: readonly {
    terminal_ref: string;
    status: RuntimeObservation;
  }[];
}
type Terminal = {
  address: string;
  state: string;
  status?: { state: string } | null;
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function observation(t: Terminal, seq: number): RuntimeObservation {
  const agent = t.status?.state;
  return {
    process:
      t.state === "live"
        ? "alive"
        : t.state === "finished"
          ? "exited"
          : "unknown",
    agent: ["working", "blocked", "done", "idle", "error"].includes(agent ?? "")
      ? (agent as RuntimeObservation["agent"])
      : "unknown",
    observed_seq: seq,
  };
}

export class HerdrRuntime implements Runtime {
  private constructor(
    readonly session: string,
    readonly socketPath: string,
    private binary: string,
    private client: HcClient,
  ) {}
  static async create(
    options: HerdrOptions = {},
  ): Promise<RuntimeResult<HerdrRuntime>> {
    return result(async () => {
      const session =
        options.session ?? process.env.CARDIGAN_HC_SESSION ?? "cardigan";
      if (!/^[a-zA-Z0-9_-]{1,48}$/u.test(session))
        fail("invalid_launch", "Invalid hc session name");
      const binary = options.binary ?? "hc";
      const socket =
        options.socketPath ??
        join(
          process.env.XDG_RUNTIME_DIR ??
            join(tmpdir(), `cardigan-${process.getuid?.() ?? "local"}`),
          "cardigan",
          `${session}.sock`,
        );
      const timeout = options.timeoutMs ?? 10000;
      if (!Number.isFinite(timeout) || timeout <= 0)
        fail("invalid_launch", "Invalid runtime timeout");
      const client =
        options.client ??
        processClient(
          binary,
          {
            ...process.env,
            ...options.env,
            HC_SESSION: session,
            HC_SOCKET: socket,
          },
          socket,
          timeout,
        );
      if (
        (await client.exec(["--version"])).trim() !==
        `hc ${options.version ?? "0.1.18"}`
      )
        fail("version_mismatch", "Unsupported hc version");
      return new HerdrRuntime(session, socket, binary, client);
    });
  }
  private async live() {
    if (!(await this.client.available()))
      fail("runtime_unavailable", "hc socket is absent");
  }
  private async json(args: string[]) {
    await this.live();
    return JSON.parse(await this.client.exec([...args, "--json"]));
  }
  private checkRef(ref: RuntimeRef) {
    if (
      ref.machine_id !== "local" ||
      ref.runtime_machine !== "local" ||
      !/^t[a-z0-9]+$/u.test(ref.terminal_ref)
    )
      fail("invalid_launch", "M2 requires a local terminal reference");
  }
  private validateLaunch(launch: RuntimeLaunch) {
    if (
      !/^[a-z0-9_-]{1,32}$/u.test(launch.agent_name) ||
      !launch.command ||
      !launch.cwd ||
      !launch.labels.project ||
      !launch.labels.run ||
      (launch.args.length === 0 && !/^[\w./+-]+$/u.test(launch.command))
    )
      fail("invalid_launch", "Invalid runtime launch description");
  }
  private async launch(launch: RuntimeLaunch, keep: boolean) {
    this.validateLaunch(launch);
    const args = [
      "run",
      "--bg",
      "--json",
      "--no-parent",
      "--no-notify",
      "--name",
      launch.agent_name,
      "--cwd",
      launch.cwd,
    ];
    if (keep) args.push("--keep");
    for (const [key, value] of Object.entries(launch.labels))
      args.push("--label", `${key}=${value}`);
    // run stops parsing options at the program: all hc options must precede it.
    const launched = JSON.parse(
      await this.client.exec([...args, "--", launch.command, ...launch.args]),
    );
    if (typeof launched.address !== "string")
      fail("runtime_unavailable", "hc did not return a terminal address");
    return launched.address as string;
  }
  provision(
    assignment: Assignment,
    role: Role,
    machine: Machine,
    launch: RuntimeLaunch,
  ) {
    return result(async () => {
      if (
        assignment.machine_id !== "local" ||
        machine.id !== "local" ||
        role.role_id !== assignment.role_id ||
        role.version !== assignment.role_version ||
        !launch.labels.project ||
        !launch.labels.run
      )
        fail("invalid_launch", "Launch identity or labels do not match");
      const terminal_ref = await this.launch(
        {
          ...launch,
          labels: {
            ...launch.labels,
            cardigan: "1",
            assignment: assignment.id,
          },
        },
        false,
      );
      return {
        machine_id: machine.id,
        runtime_machine: "local",
        terminal_ref,
        agent_name: launch.agent_name,
        ...(assignment.worktree_path
          ? { worktree_path: assignment.worktree_path }
          : {}),
        ...(assignment.branch ? { branch: assignment.branch } : {}),
      };
    });
  }
  wake(
    ref: RuntimeRef,
    doorbell: string,
    options?: { readonly if_idle?: boolean },
  ) {
    return result(async () => {
      this.checkRef(ref);
      await this.live();
      await this.client.exec([
        "send",
        "--json",
        ...(options?.if_idle ? ["--if", "idle"] : []),
        "--",
        ref.terminal_ref,
        doorbell,
      ]);
      return { sent: true };
    });
  }
  async *events(
    ref: RuntimeRef,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeResult<RuntimeEvent>> {
    const ready = await result(async () => {
      this.checkRef(ref);
      await this.live();
    });
    if (!ready.ok) {
      yield ready;
      return;
    }
    try {
      for await (const line of this.client.lines(
        ["events", "--json", "--terminal", ref.terminal_ref],
        signal,
      )) {
        const message = JSON.parse(line);
        const data = message.params ?? message;
        if (!Number.isSafeInteger(data.seq) || data.seq < 0)
          fail("runtime_unavailable", "hc event lacks a sequence");
        const terminals: Terminal[] = data.terminals ?? [];
        yield {
          ok: true,
          value: {
            seq: data.seq,
            type: data.type ?? message.method ?? "snapshot",
            ...(data.terminal ? { terminal_ref: data.terminal } : {}),
            ...(data.data === undefined ? {} : { data: data.data }),
            observations: terminals.map((t) => ({
              terminal_ref: t.address,
              status: observation(t, data.seq),
            })),
          },
        };
      }
    } catch (error) {
      yield await result<RuntimeEvent>(async () => {
        throw error;
      });
    }
  }
  status(ref: RuntimeRef) {
    return result(async () => {
      this.checkRef(ref);
      await this.json(["get", ref.terminal_ref]);
      // get has no event seq; use the newer subscription snapshot for both facts and seq.
      for await (const event of this.events(ref)) {
        if (!event.ok) fail(event.error.code, event.error.message);
        const found = event.value.observations.find(
          (t) => t.terminal_ref === ref.terminal_ref,
        );
        if (found) return found.status;
        fail(
          "runtime_not_found",
          "Terminal is absent from the runtime snapshot",
        );
      }
      return fail(
        "runtime_unavailable",
        "hc event stream ended without a snapshot",
      );
    });
  }
  interrupt(ref: RuntimeRef) {
    return result(async () => {
      this.checkRef(ref);
      await this.json(["interrupt", ref.terminal_ref, "--timeout", "2"]);
    });
  }
  resume_or_replace(ref: RuntimeRef, launch: RuntimeLaunch) {
    return result(async () => {
      this.checkRef(ref);
      this.validateLaunch(launch);
      if (ref.worktree_path && ref.worktree_path !== launch.cwd)
        fail("invalid_launch", "Replacement must reuse the worktree");
      const released = await this.release(ref, { force: true });
      if (!released.ok && released.error.code !== "runtime_not_found")
        fail(released.error.code, released.error.message);
      return {
        ...ref,
        terminal_ref: await this.launch(
          { ...launch, labels: { ...launch.labels, cardigan: "1" } },
          true,
        ),
        agent_name: launch.agent_name,
      };
    });
  }
  human_entry(ref: RuntimeRef) {
    return result(async () => {
      this.checkRef(ref);
      return `HC_SESSION=${quote(this.session)} HC_SOCKET=${quote(this.socketPath)} ${quote(this.binary)} attach ${quote(ref.terminal_ref)}`;
    });
  }
  release(ref: RuntimeRef, options: { readonly force: boolean }) {
    return result(async () => {
      this.checkRef(ref);
      const terminal: Terminal = await this.json(["get", ref.terminal_ref]);
      if (
        !options.force &&
        ["working", "blocked"].includes(terminal.status?.state ?? "")
      )
        fail("runtime_conflict", "Terminal is busy; force is required");
      if (terminal.state === "live")
        await this.json(["kill", ref.terminal_ref]);
      await this.json(["rm", ref.terminal_ref]);
    });
  }
}
