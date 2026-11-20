// @vitest-environment jsdom
// C-511: the add-worker wizard against a synthetic C-510 backend (no host).
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ApiError,
  type CardiganClient,
  HttpCardiganClient,
  type WorkerWizardAction,
  type WorkerWizardInput,
  type WorkerWizardStep,
  type WorkerWizardView,
} from "../api.js";
import { CapacityProvider } from "../components/Capacity.js";
import { fakeClient } from "../testing/fixtures.js";
import { fixtureMachines } from "../testing/machines-fixture.js";
import { MachinesSettings } from "./MachinesSettings.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const STEPS = [
  "configuration",
  "registration",
  "draft",
  "ssh",
  "account",
  "directories",
  "tools",
  "helpers",
  "resources",
  "mcp",
  "capabilities",
] as const;
const input: WorkerWizardInput = {
  machine_id: "studio",
  label: "工作室",
  os: "linux",
  arch: "x64",
  host: "worker.invalid",
  port: 22,
  account: "cg_cardigan",
  uid: 1501,
  gid: 1501,
  mcp_url: "http://control.invalid:7781/mcp",
};

/**
 * One wizard session as the C-510 routes keep it. `runs` scripts each check:
 * the steps it ends with ("blocked" at a step or "passed").
 */
function backend(runs: (WorkerWizardStep["step"] | "passed")[]) {
  let wizard: WorkerWizardView | undefined;
  let polls = 0;
  const writes: string[] = [];
  const steps = (blockedAt?: string): WorkerWizardStep[] => {
    const at = blockedAt ? STEPS.indexOf(blockedAt as never) : STEPS.length;
    return STEPS.map((step, i) =>
      i < at
        ? { step, state: "passed", elapsed_ms: 1200 }
        : i === at
          ? {
              step,
              state: "blocked",
              elapsed_ms: 300,
              reason: `worker_${step}_blocked`,
              next: "按操作手册核对后在目标机执行命令。",
            }
          : { step, state: "pending", elapsed_ms: 0 },
    );
  };
  const preview = (diff: NonNullable<WorkerWizardView["preview"]>["diff"]) => ({
    preview_id: `pv-${writes.length}-${polls}`,
    expires_at: "2026-01-01T00:15:00.000Z",
    file: "worker-studio-p-1.yaml",
    diff,
  });
  const get = () => {
    if (!wizard) throw new ApiError(404, "not_found", "没有此向导会话");
    if (wizard.phase === "running" && ++polls >= 2) {
      const outcome = runs.shift() ?? "passed";
      wizard = {
        ...wizard,
        phase: outcome === "passed" ? "passed" : "failed",
        steps: outcome === "passed" ? steps() : steps(outcome),
      };
    }
    return { wizard };
  };
  const client = {
    createWorkerWizard: vi.fn(async (_p: string, body: WorkerWizardInput) => {
      wizard = {
        id: "6f1c2a7e-0000-4000-8000-000000000001",
        machine_id: body.machine_id,
        project_id: "p-1",
        label: body.label,
        os: body.os,
        arch: body.arch,
        phase: "preview",
        steps: STEPS.map((step) => ({ step, state: "pending", elapsed_ms: 0 })),
        commands: {
          account: "sudo groupadd --gid 1501 cg_cardigan",
          directories: "sudo /usr/bin/python3 install-linux-worker.py --check",
          tools: "sudo /usr/bin/python3 -I - <<'PY'",
          helpers: "sudo install -o root worker-files.py",
        },
        command_guide: "docs/linux-worker.md",
        command_prerequisites: "仅在目标机管理员终端执行。",
        preview: preview([
          { field: "uid", change: "add", after: 1501 },
          { field: "home", change: "add", after: "已隐藏" },
          { field: "runtime.machines.0.id", change: "add", after: "studio" },
        ]),
      };
      return { wizard };
    }),
    workerWizard: vi.fn(async () => get()),
    workerWizardAction: vi.fn(
      async (_p: string, _id: string, action: WorkerWizardAction) => {
        if (!wizard) throw new ApiError(404, "not_found", "没有此向导会话");
        writes.push(action.kind);
        if (action.kind === "cancel") {
          wizard = undefined;
          return { cancelled: true as const };
        }
        if (action.kind === "confirm" || action.kind === "enable") {
          if (action.preview_id !== wizard.preview?.preview_id)
            throw new ApiError(409, "worker_preview_stale", "预览已过期");
          const { preview: _, ...rest } = wizard;
          wizard = {
            ...rest,
            phase: action.kind === "confirm" ? "ready" : "enabled",
          };
        } else if (action.kind === "run") {
          polls = 0;
          const { preview: _, ...rest } = wizard;
          wizard = {
            ...rest,
            phase: "running",
            steps: wizard.steps.map((s) =>
              s.state === "blocked" ? { ...s, state: "running" } : s,
            ),
          };
        } else {
          wizard = {
            ...wizard,
            preview: preview([
              { field: "project_binding", change: "add" },
              { field: "allow_remote_launch", change: "false → true" },
            ]),
          };
        }
        return { wizard };
      },
    ),
  };
  return { client, writes, current: () => wizard };
}

function page(extra: Partial<CardiganClient>) {
  const c = fakeClient({
    machines: vi.fn(async () => ({ machines: fixtureMachines })),
    machine: vi.fn(async (_p: string, id: string) => ({
      machine: fixtureMachines.find((m) => m.id === id) ?? fixtureMachines[0],
    })) as CardiganClient["machine"],
    ...extra,
  });
  const view = render(
    <CapacityProvider client={c} projectId="p-1" revision={0} canEdit>
      <MachinesSettings client={c} projectId="p-1" pollMs={5} />
    </CapacityProvider>,
  );
  return { c, view };
}
async function fill(dialog: ReturnType<typeof within>, values = input) {
  const field = (name: string, value: string) =>
    fireEvent.change(dialog.getByRole("textbox", { name }), {
      target: { value },
    });
  field("机器编号", values.machine_id);
  field("名称", values.label);
  field("主机地址", values.host);
  field("专用账号", values.account);
  field("UID", String(values.uid));
  field("GID", String(values.gid));
  field("MCP 地址", values.mcp_url);
}
const header = () =>
  within(screen.getByRole("dialog"))
    .getAllByRole("button")
    .filter((b) => b.closest(".drawer-actions"))
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);

test("nine steps: preview, confirm before writing, fail in place, continue, then a separate remote-launch confirmation", async () => {
  const fake = backend(["ssh", "passed"]);
  const { c } = page(fake.client);
  await screen.findByRole("table", { name: "机器列表" });
  fireEvent.click(screen.getByRole("button", { name: "添加 worker" }));
  let dialog = within(await screen.findByRole("dialog"));
  // A mistake shows before anything is sent.
  await fill(dialog, { ...input, account: "worker" });
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await dialog.findByText(
    "专用账号须以 cg_ 开头，只含小写字母、数字和下划线。",
  );
  expect(fake.client.createWorkerWizard).not.toHaveBeenCalled();
  await fill(dialog);
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  // Preview: redacted diff; nothing written yet.
  const diff = await dialog.findByRole("table", { name: "工作室 配置差异" });
  expect(fake.client.createWorkerWizard).toHaveBeenCalledWith("p-1", input);
  expect(within(diff).getByText("已隐藏")).toBeTruthy();
  expect(dialog.queryByText("worker.invalid")).toBeNull();
  expect(fake.writes).toEqual([]);
  expect(header()).toEqual(["放弃", "关闭抽屉"]);
  fireEvent.click(dialog.getByRole("button", { name: "确认写入配置" }));
  await waitFor(() =>
    expect(header()).toEqual(["放弃", "开始检查", "关闭抽屉"]),
  );
  expect(fake.client.workerWizardAction).toHaveBeenLastCalledWith(
    "p-1",
    expect.any(String),
    { kind: "confirm", preview_id: "pv-0-0" },
  );
  // All steps listed; the nine onboarding steps are numbered.
  const steps = dialog.getByRole("table", { name: "接入步骤" });
  const names = within(steps)
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]?.textContent);
  expect(names).toEqual([
    "配置核对",
    "1. 登记",
    "2. 草稿",
    "3. SSH",
    "4. 账号",
    "5. 目录",
    "6. 工具",
    "7. helper",
    "8. 资源",
    "9. MCP",
    "能力刷新",
  ]);
  fireEvent.click(dialog.getByRole("button", { name: "开始检查" }));
  expect(
    (await dialog.findByRole("button", { name: "检查中…" })).getAttribute(
      "aria-disabled",
    ),
  ).toBe("true");
  // The failed step says why and what to do, in place.
  await waitFor(() =>
    expect(header()).toEqual(["放弃", "继续检查", "关闭抽屉"]),
  );
  const ssh = within(
    within(dialog.getByRole("table", { name: "接入步骤" }))
      .getByText("3. SSH")
      .closest("tr") as HTMLElement,
  );
  expect(ssh.getByText("worker_ssh_blocked")).toBeTruthy();
  expect(ssh.getByText("按操作手册核对后在目标机执行命令。")).toBeTruthy();
  expect(ssh.getByText("受阻")).toBeTruthy();
  const listReads = vi.mocked(c.machines).mock.calls.length;
  fireEvent.click(dialog.getByRole("button", { name: "继续检查" }));
  await waitFor(() => expect(header()).toEqual(["复查", "完成", "关闭抽屉"]));
  // The check may have registered the machine: the list reads again.
  expect(vi.mocked(c.machines).mock.calls.length).toBeGreaterThan(listReads);
  // Remote launch stays off until previewed and confirmed separately.
  expect(dialog.getByText("未开启")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "预览开启" }));
  await dialog.findByRole("table", { name: "派发配置差异" });
  const enable = dialog.getByRole("button", { name: "开启远程派发" });
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(dialog.getByRole("checkbox", { name: "我确认开启远程派发" }));
  fireEvent.click(enable);
  await dialog.findByText("已开启远程派发");
  expect(fake.client.workerWizardAction).toHaveBeenLastCalledWith(
    "p-1",
    expect.any(String),
    {
      kind: "enable",
      preview_id: expect.any(String),
      allow_remote_launch: true,
    },
  );
  expect(fake.writes).toEqual([
    "confirm",
    "run",
    "run",
    "launch-preview",
    "enable",
  ]);
  fireEvent.click(dialog.getByRole("button", { name: "完成" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(window.localStorage.length).toBe(0);
  dialog = within(document.body);
  expect(dialog.getByRole("button", { name: "添加 worker" })).toBeTruthy();
});

test("leaving keeps the session: the page offers to continue from the current step, also after a reload", async () => {
  const fake = backend([]);
  page(fake.client);
  fireEvent.click(await screen.findByRole("button", { name: "添加 worker" }));
  const dialog = within(await screen.findByRole("dialog"));
  await fill(dialog);
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  fireEvent.click(await dialog.findByRole("button", { name: "确认写入配置" }));
  await dialog.findByRole("button", { name: "开始检查" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("已保留添加 worker 的进度，可稍后继续")).toBeTruthy();
  expect(fake.writes).toEqual(["confirm"]);
  // A new page (e.g. after leaving settings) still knows the session.
  cleanup();
  page(fake.client);
  fireEvent.click(
    await screen.findByRole("button", { name: "继续添加 worker" }),
  );
  const again = within(await screen.findByRole("dialog"));
  await again.findByRole("table", { name: "接入步骤" });
  expect(fake.client.workerWizard).toHaveBeenCalledWith(
    "p-1",
    "6f1c2a7e-0000-4000-8000-000000000001",
  );
  expect(header()).toEqual(["放弃", "开始检查", "关闭抽屉"]);
  // 放弃 ends the session on the server too.
  fireEvent.click(again.getByRole("button", { name: "放弃" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.current()).toBeUndefined();
  expect(screen.getByText("已放弃添加 worker")).toBeTruthy();
  expect(screen.getByRole("button", { name: "添加 worker" })).toBeTruthy();
});

test("commands copy for manual runs; a session gone from the server starts over", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const fake = backend([]);
  page(fake.client);
  fireEvent.click(await screen.findByRole("button", { name: "添加 worker" }));
  const dialog = within(await screen.findByRole("dialog"));
  await fill(dialog);
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  fireEvent.click(await dialog.findByRole("button", { name: "确认写入配置" }));
  const commands = await dialog.findByRole("table", { name: "目标机命令" });
  expect(dialog.getByText("仅在目标机管理员终端执行。")).toBeTruthy();
  fireEvent.click(
    within(commands).getByRole("button", { name: "复制“账号”命令" }),
  );
  await dialog.findByText("已复制“账号”命令");
  expect(writeText).toHaveBeenCalledWith(
    "sudo groupadd --gid 1501 cg_cardigan",
  );
  cleanup();
  // The server forgot it (restart, 24 hours): the form is shown again.
  const gone = backend([]);
  window.localStorage.setItem(
    "cardigan.worker-wizard.p-1",
    "6f1c2a7e-0000-4000-8000-000000000002",
  );
  page(gone.client);
  fireEvent.click(
    await screen.findByRole("button", { name: "继续添加 worker" }),
  );
  const fresh = within(await screen.findByRole("dialog"));
  await fresh.findByText("向导已失效（服务重启或超过 24 小时），请重新填写。");
  expect(fresh.getByRole("button", { name: "预览配置" })).toBeTruthy();
  expect(window.localStorage.length).toBe(0);
});

test("refusals are explained, and a stale preview is read again instead of written", async () => {
  const fake = backend([]);
  const create = fake.client.createWorkerWizard;
  fake.client.createWorkerWizard = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(409, "worker_identity_conflict", "请核对"),
    )
    .mockImplementation(create);
  page(fake.client);
  fireEvent.click(await screen.findByRole("button", { name: "添加 worker" }));
  const dialog = within(await screen.findByRole("dialog"));
  await fill(dialog);
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await dialog.findByText(
    "这个机器编号已按不同的系统或架构登记，请换一个编号或核对已有登记。",
  );
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  const confirm = await dialog.findByRole("button", { name: "确认写入配置" });
  const reads = fake.client.workerWizard.mock.calls.length;
  vi.mocked(fake.client.workerWizardAction).mockRejectedValueOnce(
    new ApiError(409, "worker_preview_stale", "预览已过期"),
  );
  fireEvent.click(confirm);
  await dialog.findByText(
    "预览已过期或状态已改变，已重新读取，请核对后再确认。",
  );
  await waitFor(() =>
    expect(fake.client.workerWizard.mock.calls.length).toBeGreaterThan(reads),
  );
  expect(fake.current()?.phase).toBe("preview");
});

test("while a step is being sent the drawer does not close", async () => {
  const fake = backend([]);
  const held = Promise.withResolvers<{ wizard: WorkerWizardView }>();
  const create = fake.client.createWorkerWizard;
  fake.client.createWorkerWizard = vi.fn(async (p, body) => {
    await held.promise;
    return create(p, body);
  });
  page(fake.client);
  fireEvent.click(await screen.findByRole("button", { name: "添加 worker" }));
  const dialog = within(await screen.findByRole("dialog"));
  await fill(dialog);
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await dialog.findByText("正在提交…");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => held.resolve({} as never));
  await dialog.findByRole("button", { name: "确认写入配置" });
});

test("the wizard requests are same-origin JSON to the C-510 routes, without automatic retry keys", async () => {
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ wizard: {} })),
  );
  const http = new HttpCardiganClient(fetcher);
  await http.createWorkerWizard("p 1", input);
  await http.workerWizard("p 1", "w-1");
  await http.workerWizardAction("p 1", "w-1", {
    kind: "confirm",
    preview_id: "pv",
  });
  await http.workerWizardAction("p 1", "w-1", { kind: "run" });
  await http.workerWizardAction("p 1", "w-1", {
    kind: "enable",
    preview_id: "pv",
    allow_remote_launch: true,
  });
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
    ["/api/projects/p%201/worker-wizards", "POST", JSON.stringify(input)],
    ["/api/projects/p%201/worker-wizards/w-1", "GET", undefined],
    [
      "/api/projects/p%201/worker-wizards/w-1/confirm",
      "POST",
      '{"preview_id":"pv"}',
    ],
    ["/api/projects/p%201/worker-wizards/w-1/run", "POST", "{}"],
    [
      "/api/projects/p%201/worker-wizards/w-1/enable",
      "POST",
      '{"preview_id":"pv","allow_remote_launch":true}',
    ],
  ]);
  for (const [, init] of calls) {
    const headers = new Headers(init.headers);
    expect(headers.get("idempotency-key")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(init.credentials).toBe("same-origin");
  }
});
