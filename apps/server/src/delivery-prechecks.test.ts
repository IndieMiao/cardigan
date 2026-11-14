import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  latestDeliveryPrecheck,
  requestDeliveryPrecheck,
} from "@cardigan/domain";
import {
  type CheckoutInput,
  createMergeCheckLog,
  type ProjectMergeGate,
} from "@cardigan/host";
import { afterEach, expect, test, vi } from "vitest";
import { DeliveryPrechecks } from "./delivery-prechecks.js";
import { type M4Fixture, m4Fixture, m4Scenario } from "./m4-fixtures.js";

const fixtures: M4Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const secret = "synthetic-secret/value";
const fault = () =>
  new Error(
    `synthetic failure: ${secret}; token=hidden-fixture-token; /private/fixture/repository`,
  );
async function fixture() {
  const f = m4Fixture();
  fixtures.push(f);
  const scenario = m4Scenario(f);
  f.startRun(scenario.coder);
  const delivery = await f.deliver(scenario.coder, scenario.development.id, {
    subject: "a".repeat(40),
    verifiers: [scenario.codeReview.id],
  });
  f.apply(
    (s, a, p) => requestDeliveryPrecheck(s, a, { delivery_id: delivery.id }, p),
    f.human,
  );
  const settings: ProjectMergeGate = {
    status: "enabled",
    checks: [{ name: "test", run: "true" }],
    env: { SECRET: secret },
    totalTimeoutMs: 1000,
    executor: {
      name: "fixture-ci",
      host: "fixture.invalid",
      port: 22,
      user: "agent",
      identityFile: "fixture-key",
      knownHostsFile: "fixture-hosts",
      hostKeyAlias: "fixture-ci",
      agentRoot: "/fixture-root",
      maxConcurrent: 1,
    },
  };
  const release = vi.fn();
  const options = {
    store: f.store,
    clock: f.clock,
    configuration: { errors: [], forProject: () => settings },
    execution: { mode: "local" as const, dataDir: f.dataDir },
    signal: new AbortController().signal,
    reserve: vi.fn(async () => ({ index: 0, release })),
    onError: vi.fn(),
    git: {
      projectOf: () => ({
        project_id: f.project_id,
        source_repo: "fixture",
        base_branch: "main",
      }),
      baseline: vi.fn(async () => "b".repeat(40)),
      deliveryTree: vi.fn(async () => "c".repeat(40)),
      distribute: vi.fn(async () => {}),
    },
    createLog: vi.fn(createMergeCheckLog),
    run: vi.fn(async (input: CheckoutInput) => {
      input.onReady?.();
      return {
        status: "passed" as const,
        checks: [{ name: "test", status: "passed" as const, exit_code: 0 }],
        cleanup_errors: [],
      };
    }),
  };
  const controller = new DeliveryPrechecks(options);
  return {
    f,
    options,
    release,
    controller,
    check: () => latestDeliveryPrecheck(f.state().events, delivery),
  };
}

test.each([
  ["baseline", "读取基线"],
  ["deliveryTree", "读取交付树"],
  ["distribute", "分发交付"],
  ["run", "运行检查"],
  ["createLog", "创建日志"],
] as const)(
  "precheck %s errors retain their safe stage and diagnosis",
  async (operation, label) => {
    const { f, options, release, controller, check } = await fixture();
    if (operation === "run" || operation === "createLog")
      options[operation].mockRejectedValueOnce(fault());
    else options.git[operation].mockRejectedValueOnce(fault());
    await (await controller.schedule([f.project_id])).done;
    expect(check()?.status).toBe("environment_failed");
    expect(check()?.summary).toContain(`${label}失败`);
    expect(check()?.summary).toContain("synthetic failure");
    expect(options.onError).toHaveBeenCalledOnce();
    const logged = options.onError.mock.calls[0]?.[0] as Error;
    const evidence =
      JSON.stringify(f.state().events) + logged.message + logged.stack;
    for (const value of [
      secret,
      "hidden-fixture-token",
      "/private/fixture/repository",
    ])
      expect(evidence).not.toContain(value);
    expect(logged.cause).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    expect(f.state().deliveries[0]?.status).toBe("submitted");
    if (check()?.log_ref) {
      const log = await readFile(
        join(
          f.dataDir,
          "merge-gate",
          "logs",
          f.project_id,
          check()?.log_ref ?? "",
        ),
        "utf8",
      );
      expect(log).toContain(`${label}失败`);
      expect(log).not.toContain(secret);
    }
  },
);

test.each(["none", "generic", "unreachable"] as const)(
  "a failed log is not finalized twice or allowed to hide the original failure (run failed=%s)",
  async (failure) => {
    const runFailed = failure !== "none";
    const { f, options, release, controller, check } = await fixture();
    const finish = vi
      .fn<Awaited<ReturnType<typeof createMergeCheckLog>>["finish"]>()
      .mockRejectedValue(new Error("synthetic log write failure /private/log"));
    options.createLog.mockImplementationOnce(async (input) => ({
      log_ref: `${input.attempt}.log`,
      append: () => {},
      finish,
    }));
    if (runFailed)
      options.run.mockRejectedValueOnce(
        failure === "unreachable"
          ? new Error("ssh: connect to host: Connection refused")
          : fault(),
      );
    await (await controller.schedule([f.project_id])).done;
    expect(check()?.status).toBe("environment_failed");
    expect(check()?.summary).toContain("保存日志失败");
    if (runFailed) expect(check()?.summary).toContain("运行检查失败");
    expect(check()?.summary).not.toContain("/private/log");
    expect(check()?.log_ref).toBeUndefined();
    expect(finish).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(options.onError).toHaveBeenCalledTimes(runFailed ? 2 : 1);
    await (await controller.schedule([f.project_id])).done;
    expect(options.run).toHaveBeenCalledOnce();
  },
);
