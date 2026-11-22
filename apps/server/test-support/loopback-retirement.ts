import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeTargetBinding } from "@cardigan/host";
import { expect, vi } from "vitest";
import * as ssh from "../../../packages/runtime-herdr/src/agent-ssh.js";
import {
  HC_RELEASE,
  HerdrRuntime,
} from "../../../packages/runtime-herdr/src/index.js";

/** Actual adapter and pidfd command sequence; replace both worker transports
 * with bounded fixture responses. No hc socket, SSH connection or real signal. */
export async function loopbackFixture(
  dir: string,
  project: string,
  assignment: string,
) {
  const machine = "cardigan-agent",
    session = "fixture";
  const endpoint = join(dir, "fixture-identity"),
    knownHostsFile = join(dir, "fixture-hosts");
  const config = {
    mode: "agent-ssh" as const,
    machine,
    dataDir: dir,
    agentRoot: join(dir, "agent"),
    gid: process.getgid?.() ?? -1,
    identityFile: endpoint,
    knownHostsFile,
  };
  const target = runtimeTargetBinding({
    project_id: project,
    machine_id: "local",
    generation: "legacy",
    execution: config,
    session,
  });
  const execution = { ...config, target };
  const labels: Record<string, string> = {};
  for (const file of [endpoint, knownHostsFile])
    writeFileSync(file, "fixture only", { mode: 0o600 });
  let sample = "conflict",
    exited = false;
  const signals: string[] = [];
  vi.spyOn(ssh, "agentProcessCommand").mockImplementation(
    async (_, args, options) => {
      expect(options).toEqual({ workerRuntimeDir: true });
      const [source, payload] = args.slice(-2);
      if (!source || !payload) throw new Error("Missing collector arguments");
      const c = JSON.parse(payload);
      expect(c).toMatchObject({
        project: target.project_id,
        assignment,
        launch_run: labels.run,
        generation: null,
        terminal: "t2",
        session: target.session,
        local: true,
      });
      const t = {
        address: "t2",
        state: exited ? "finished" : "live",
        keep: false,
        created_ms: 1234,
        ...(sample !== "incomplete" ? { pid: 12345 } : {}),
        status: { state: sample === "busy" ? "working" : "idle" },
        labels: {
          ...labels,
          ...(sample === "conflict" ? { assignment: "other" } : {}),
          ...(sample === "wrong-run" ? { run: "R-99999" } : {}),
          ...(sample === "unexpected-generation"
            ? { generation: "other" }
            : {}),
        },
      };
      return {
        // Run the shipped projection; substitute only the socket and Linux account/uid facts.
        file: "/usr/bin/python3",
        args: [
          "-IB",
          "-c",
          workerSocket,
          source,
          JSON.stringify(c),
          JSON.stringify(t),
        ],
      };
    },
  );
  const result = await HerdrRuntime.create({
    session: target.session,
    execution,
    socketPath: join(dir, "relay.sock"),
    client: {
      available: async () => true,
      async *lines() {
        yield JSON.stringify({
          seq: 1,
          terminals: [{ address: `${machine}/t2`, state: "live" }],
        });
      },
      exec: async (args) => {
        if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
        if (args[0] === "machine")
          return JSON.stringify(
            args[1] === "ls"
              ? { machines: [] }
              : { version: HC_RELEASE.version },
          );
        if (args[0] === "run") {
          for (const [i, arg] of args.slice(0, args.indexOf("--")).entries()) {
            if (arg !== "--label") continue;
            const [key, value] = args[i + 1]?.split("=") ?? [];
            if (!key || !value) throw new Error("Invalid fixture launch label");
            labels[key] = value;
          }
          return JSON.stringify({ address: `${machine}/t2` });
        }
        // The relay can see a live address, but has no worker owner labels.
        if (args[0] === "get")
          return JSON.stringify({ address: `${machine}/t2`, state: "live" });
        expect(args.slice(0, 4)).toEqual(["exec", "--on", machine, "--"]);
        const mode = args[args.indexOf("-c") + 2];
        if (mode === "probe")
          return JSON.stringify({
            pid: 12345,
            start: "1",
            boot: "fixture",
            uid: 1001,
          });
        expect(mode).toBe("TERM");
        signals.push(mode);
        exited = true;
        return "";
      },
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return {
    runtime: result.value,
    execution,
    labels,
    signals,
    sample: (v: string) => {
      sample = v;
    },
  };
}

const workerSocket = `import sys, json, contextlib, types
scope = {"__name__": "fixture"}
exec(sys.argv[1], scope)
binding, terminal = map(json.loads, sys.argv[2:])
def get(method, params):
    assert method == "terminal.get" and params == {"terminal": terminal["address"]}
    return terminal
scope.update(core_rpc=lambda *_: contextlib.nullcontext(get), managed_loopback_account=lambda *_: None,
             pwd=types.SimpleNamespace(getpwuid=lambda _: types.SimpleNamespace(pw_dir="/fixture")),
             os=types.SimpleNamespace(getuid=lambda: 1001, geteuid=lambda: 1001,
                                      stat=lambda _: types.SimpleNamespace(st_uid=1001)))
print(json.dumps(scope["retirement_terminal"](binding)))`;
