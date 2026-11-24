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
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { fixtureMachines } from "../testing/machines-fixture.js";
import { MachinesSettings } from "./MachinesSettings.js";
import { storedWizard, WorkerWizardDrawer } from "./WorkerWizard.js";

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
  mcp_url: "https://control.example.ts.net/mcp",
};

/**
 * One wizard session as the C-510 routes keep it. `runs` scripts each check:
 * the steps it ends with ("blocked" at a step or "passed").
 */
function backend(runs: (WorkerWizardStep["step"] | "passed")[]) {
  let wizard: WorkerWizardView | undefined;
  let polls = 0;
  let previews = 0;
  let checks = 0;
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
    // Like the server, every preview gets a fresh id.
    preview_id: `pv-${++previews}`,
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
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
        // Like the server: an automatic recheck only continues its check.
        if (
          "resume_check_id" in action &&
          (wizard.phase !== "failed" ||
            wizard.check_id !== action.resume_check_id)
        )
          throw new ApiError(409, "worker_check_changed", "向导状态已改变");
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
            check_id: `check-${++checks}`,
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
  return {
    client,
    writes,
    current: () => wizard,
    /** Change the session as the server would between two reads. */
    mutate: (change: (w: WorkerWizardView) => WorkerWizardView) => {
      if (wizard) wizard = change(wizard);
    },
  };
}
/** Fill, preview, confirm and pass the checks: the remote-launch state. */
async function toPassed(fake: ReturnType<typeof backend>) {
  page(fake.client);
  fireEvent.click(await screen.findByRole("button", { name: "添加 worker" }));
  const dialog = within(await screen.findByRole("dialog"));
  await fill(dialog);
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  fireEvent.click(await dialog.findByRole("button", { name: "确认写入配置" }));
  fireEvent.click(await dialog.findByRole("button", { name: "开始检查" }));
  await dialog.findByRole("button", { name: "复查" });
  return dialog;
}
/** Resume a ready session this browser holds, as after leaving the page. */
async function heldSession(fake: ReturnType<typeof backend>) {
  await fake.client.createWorkerWizard("p-1", input);
  await fake.client.workerWizardAction("p-1", "x", {
    kind: "confirm",
    preview_id: fake.current()?.preview?.preview_id ?? "",
  });
  window.localStorage.setItem(
    "cardigan.worker-wizard.p-1",
    fake.current()?.id ?? "",
  );
  fake.writes.length = 0;
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
    { kind: "confirm", preview_id: "pv-1" },
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
  const launchDiff = await dialog.findByRole("table", { name: "派发配置差异" });
  // "false → true" is shown in the 原值 / 新值 columns, as a 修改.
  const cells = within(
    within(launchDiff)
      .getByText("allow_remote_launch")
      .closest("tr") as HTMLElement,
  )
    .getAllByRole("cell")
    .map((c) => c.textContent);
  expect(cells).toEqual(["allow_remote_launch", "false", "true", "修改"]);
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

test("V-2530: the remote-launch tick belongs to one preview; a replaced preview needs a new tick", async () => {
  const fake = backend(["passed"]);
  const dialog = await toPassed(fake);
  fireEvent.click(dialog.getByRole("button", { name: "预览开启" }));
  await dialog.findByRole("table", { name: "派发配置差异" });
  fireEvent.click(dialog.getByRole("checkbox", { name: "我确认开启远程派发" }));
  // Meanwhile the server replaced the preview (e.g. another tab).
  fake.mutate((w) => ({
    ...w,
    preview: {
      ...(w.preview as NonNullable<WorkerWizardView["preview"]>),
      preview_id: "pv-other",
      diff: [{ field: "machine", change: "add" }],
    },
  }));
  vi.mocked(fake.client.workerWizardAction).mockRejectedValueOnce(
    new ApiError(409, "worker_preview_stale", "预览已过期"),
  );
  fireEvent.click(dialog.getByRole("button", { name: "开启远程派发" }));
  await dialog.findByText(
    "预览已过期或状态已改变，已重新读取，请核对后再确认。",
  );
  // The new preview is shown, unticked, and cannot be sent unticked.
  await within(dialog.getByRole("table", { name: "派发配置差异" })).findByText(
    "machine",
  );
  const box = dialog.getByRole("checkbox", { name: "我确认开启远程派发" });
  expect(box.getAttribute("aria-checked")).toBe("false");
  expect(
    (dialog.getByRole("button", { name: "开启远程派发" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(fake.current()?.phase).toBe("passed");
});

test("V-2530: an expired launch preview is fetched again instead of sent", async () => {
  const fake = backend(["passed"]);
  const dialog = await toPassed(fake);
  // This preview expires shortly after it is shown.
  const action = fake.client.workerWizardAction;
  vi.mocked(action).mockImplementationOnce(async (p, id, a) => {
    const reply = await action.getMockImplementation()?.(p, id, a);
    fake.mutate((w) => ({
      ...w,
      preview: {
        ...(w.preview as NonNullable<WorkerWizardView["preview"]>),
        expires_at: new Date(Date.now() + 150).toISOString(),
      },
    }));
    return { ...(reply as object), wizard: fake.current() } as never;
  });
  fireEvent.click(dialog.getByRole("button", { name: "预览开启" }));
  await dialog.findByRole("button", { name: "开启远程派发" });
  fireEvent.click(dialog.getByRole("checkbox", { name: "我确认开启远程派发" }));
  // Once it expires it can no longer be sent; it is fetched again.
  await dialog.findByText("派发预览已过期，请重新预览。", undefined, {
    timeout: 2000,
  });
  expect(dialog.queryByRole("checkbox")).toBeNull();
  expect(dialog.queryByRole("button", { name: "开启远程派发" })).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "重新预览" }));
  const enable = await dialog.findByRole("button", { name: "开启远程派发" });
  // The new preview needs its own tick.
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  expect(fake.writes.filter((w) => w === "launch-preview")).toHaveLength(2);
  expect(fake.writes).not.toContain("enable");
});

test("V-2530: a refused read takes the owner-only content down until a read is allowed again", async () => {
  const fake = backend([]);
  await heldSession(fake);
  page(fake.client);
  fireEvent.click(
    await screen.findByRole("button", { name: "继续添加 worker" }),
  );
  const dialog = within(await screen.findByRole("dialog"));
  await dialog.findByRole("table", { name: "目标机命令" });
  // The owner changed: the action and the reread are refused.
  const refused = new ApiError(403, "unauthorized", "仅限当前所有者");
  vi.mocked(fake.client.workerWizardAction).mockRejectedValueOnce(refused);
  fake.client.workerWizard.mockRejectedValueOnce(refused);
  fireEvent.click(dialog.getByRole("button", { name: "开始检查" }));
  await dialog.findByText(/没有权限查看这个向导/);
  expect(dialog.queryByRole("table", { name: "目标机命令" })).toBeNull();
  expect(dialog.queryByText(/sudo/)).toBeNull();
  expect(dialog.queryByRole("button", { name: "预览配置" })).toBeNull();
  expect(header()).toEqual(["关闭抽屉"]);
  // A retry that is refused again keeps it down.
  fake.client.workerWizard.mockRejectedValueOnce(refused);
  fireEvent.click(dialog.getByRole("button", { name: "重试" }));
  await waitFor(() =>
    expect(fake.client.workerWizard.mock.calls.length).toBeGreaterThanOrEqual(
      3,
    ),
  );
  await dialog.findByText(/没有权限查看这个向导/);
  expect(dialog.queryByRole("table", { name: "目标机命令" })).toBeNull();
  // Allowed again: the session comes back where it was.
  fireEvent.click(dialog.getByRole("button", { name: "重试" }));
  await dialog.findByRole("table", { name: "目标机命令" });
  expect(header()).toEqual(["放弃", "开始检查", "关闭抽屉"]);
});

test("V-2530: a retried progress read resumes polling until the check ends", async () => {
  const fake = backend(["ssh"]);
  await heldSession(fake);
  page(fake.client);
  fireEvent.click(
    await screen.findByRole("button", { name: "继续添加 worker" }),
  );
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.click(await dialog.findByRole("button", { name: "开始检查" }));
  fake.client.workerWizard.mockRejectedValueOnce(new TypeError("network"));
  await dialog.findByText(/未能读取向导进度/);
  const reads = fake.client.workerWizard.mock.calls.length;
  fireEvent.click(dialog.getByRole("button", { name: "重试" }));
  // Polling continues after the manual read until the check ends.
  await waitFor(() =>
    expect(header()).toEqual(["放弃", "继续检查", "关闭抽屉"]),
  );
  expect(fake.client.workerWizard.mock.calls.length).toBeGreaterThan(reads + 1);
});

test("V-2530: a held session that cannot be read now is not replaced by a blank form", async () => {
  const fake = backend([]);
  await heldSession(fake);
  fake.client.workerWizard.mockRejectedValueOnce(new TypeError("network"));
  page(fake.client);
  fireEvent.click(
    await screen.findByRole("button", { name: "继续添加 worker" }),
  );
  const dialog = within(await screen.findByRole("dialog"));
  await dialog.findByText(/未能读取向导进度/);
  expect(dialog.queryByRole("button", { name: "预览配置" })).toBeNull();
  expect(header()).toEqual(["放弃并重新填写", "关闭抽屉"]);
  // Retry continues the held session.
  fireEvent.click(dialog.getByRole("button", { name: "重试" }));
  await dialog.findByRole("button", { name: "开始检查" });
  cleanup();
  // Or the reader gives it up explicitly and starts afresh.
  fake.client.workerWizard.mockRejectedValueOnce(new TypeError("network"));
  page(fake.client);
  fireEvent.click(
    await screen.findByRole("button", { name: "继续添加 worker" }),
  );
  const again = within(await screen.findByRole("dialog"));
  await again.findByText(/未能读取向导进度/);
  fireEvent.click(again.getByRole("button", { name: "放弃并重新填写" }));
  expect(again.getByRole("button", { name: "预览配置" })).toBeTruthy();
  expect(window.localStorage.length).toBe(0);
  expect(fake.current()?.phase).toBe("ready");
});

test("V-2530: a preview the server accepted after the page was left can still be continued", async () => {
  const fake = backend([]);
  const held = Promise.withResolvers<void>();
  const create = fake.client.createWorkerWizard;
  fake.client.createWorkerWizard = vi.fn(async (p, body) => {
    const reply = await create(p, body);
    await held.promise;
    return reply;
  });
  page(fake.client);
  fireEvent.click(await screen.findByRole("button", { name: "添加 worker" }));
  const dialog = within(await screen.findByRole("dialog"));
  await fill(dialog);
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await waitFor(() => expect(fake.current()).toBeTruthy());
  // Leave (e.g. another settings panel) before the reply arrives.
  cleanup();
  await act(async () => held.resolve());
  expect(window.localStorage.getItem("cardigan.worker-wizard.p-1")).toBe(
    fake.current()?.id,
  );
  page(fake.client);
  fireEvent.click(
    await screen.findByRole("button", { name: "继续添加 worker" }),
  );
  const again = within(await screen.findByRole("dialog"));
  await again.findByRole("button", { name: "确认写入配置" });
});

test("editing the preview to another machine gives up the replaced session", async () => {
  const fake = backend([]);
  // The fake reuses its id; give the next session a new one.
  const create = fake.client.createWorkerWizard;
  let creates = 0;
  fake.client.createWorkerWizard = vi.fn(async (p, body) => {
    const reply = await create(p, body);
    if (++creates === 1) return reply;
    fake.mutate((w) => ({ ...w, id: "6f1c2a7e-0000-4000-8000-0000000000aa" }));
    return { wizard: fake.current() as WorkerWizardView };
  });
  page(fake.client);
  fireEvent.click(await screen.findByRole("button", { name: "添加 worker" }));
  const dialog = within(await screen.findByRole("dialog"));
  await fill(dialog);
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  fireEvent.click(await dialog.findByRole("button", { name: "返回修改" }));
  const first = fake.current()?.id;
  fireEvent.change(dialog.getByRole("textbox", { name: "机器编号" }), {
    target: { value: "studio-2" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await dialog.findByRole("button", { name: "确认写入配置" });
  await waitFor(() =>
    expect(fake.client.workerWizardAction).toHaveBeenCalledWith("p-1", first, {
      kind: "cancel",
    }),
  );
  expect(window.localStorage.getItem("cardigan.worker-wizard.p-1")).toBe(
    "6f1c2a7e-0000-4000-8000-0000000000aa",
  );
});

test("V-2540: a late read for a session given up cannot clear or replace the new one", async () => {
  for (const late of ["404", "ok"] as const) {
    const fake = backend([]);
    await heldSession(fake);
    const old = fake.current() as WorkerWizardView;
    const pending = Promise.withResolvers<{ wizard: WorkerWizardView }>();
    fake.client.workerWizard
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockImplementationOnce(() => pending.promise);
    page(fake.client);
    fireEvent.click(
      await screen.findByRole("button", { name: "继续添加 worker" }),
    );
    const d = within(await screen.findByRole("dialog"));
    fireEvent.click(await d.findByRole("button", { name: "重试" }));
    fireEvent.click(d.getByRole("button", { name: "放弃并重新填写" }));
    await fill(d);
    const created: WorkerWizardView = {
      ...old,
      id: "6f1c2a7e-0000-4000-8000-0000000000bb",
      phase: "preview",
      preview: {
        preview_id: "new-pv",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        file: "worker-studio-p-1.yaml",
        diff: [],
      },
    };
    fake.client.createWorkerWizard.mockResolvedValueOnce({ wizard: created });
    fireEvent.click(d.getByRole("button", { name: "预览配置" }));
    await d.findByRole("button", { name: "确认写入配置" });
    // The old session's read answers late (gone, or still there).
    await act(async () =>
      late === "404"
        ? pending.reject(new ApiError(404, "not_found", "旧会话已不存在"))
        : pending.resolve({ wizard: { ...old, phase: "ready" } }),
    );
    expect(window.localStorage.getItem("cardigan.worker-wizard.p-1")).toBe(
      created.id,
    );
    expect(d.getByRole("button", { name: "确认写入配置" })).toBeTruthy();
    expect(d.queryByRole("form", { name: "worker 接入信息" })).toBeNull();
    expect(d.queryByRole("button", { name: "开始检查" })).toBeNull();
    cleanup();
    window.localStorage.clear();
  }
});

test("V-2540: a preview the server refused with time left is not sent again; a new one can be fetched", async () => {
  const fake = backend(["passed"]);
  const d = await toPassed(fake);
  fireEvent.click(d.getByRole("button", { name: "预览开启" }));
  fireEvent.click(
    await d.findByRole("checkbox", { name: "我确认开启远程派发" }),
  );
  const original = fake.current()?.preview?.preview_id;
  // A guarded file changed: the server refuses, then returns the same,
  // unexpired preview on the reread.
  vi.mocked(fake.client.workerWizardAction).mockRejectedValueOnce(
    new ApiError(409, "worker_preview_stale", "配置另有改动"),
  );
  fireEvent.click(d.getByRole("button", { name: "开启远程派发" }));
  await d.findByText("派发预览已失效，请重新预览。");
  expect(fake.current()?.preview?.preview_id).toBe(original);
  expect(d.queryByRole("checkbox")).toBeNull();
  expect(d.queryByRole("button", { name: "开启远程派发" })).toBeNull();
  fireEvent.click(d.getByRole("button", { name: "重新预览" }));
  const enable = await d.findByRole("button", { name: "开启远程派发" });
  expect(fake.current()?.preview?.preview_id).not.toBe(original);
  expect((enable as HTMLButtonElement).disabled).toBe(true);
});

test("V-2540: a refused config preview cannot be confirmed again; 返回修改 remains", async () => {
  const fake = backend([]);
  page(fake.client);
  fireEvent.click(await screen.findByRole("button", { name: "添加 worker" }));
  const d = within(await screen.findByRole("dialog"));
  await fill(d);
  fireEvent.click(d.getByRole("button", { name: "预览配置" }));
  const confirm = await d.findByRole("button", { name: "确认写入配置" });
  vi.mocked(fake.client.workerWizardAction).mockRejectedValueOnce(
    new ApiError(409, "worker_preview_stale", "文件另有改动"),
  );
  fireEvent.click(confirm);
  await d.findByText("这份预览已失效，请返回修改后重新预览。");
  expect(
    (d.getByRole("button", { name: "确认写入配置" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(d.getByRole("button", { name: "返回修改" }));
  fireEvent.click(d.getByRole("button", { name: "预览配置" }));
  await waitFor(() =>
    expect(
      (d.getByRole("button", { name: "确认写入配置" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

/** C-565: the drawer alone, with quick automatic rechecks. */
function drawer(
  extra: Partial<CardiganClient>,
  props: { autoRecheckMs?: number; autoRecheckMax?: number } = {},
) {
  const c = fakeClient(extra);
  const onChanged = vi.fn();
  render(
    <WorkerWizardDrawer
      client={c}
      projectId="p-1"
      pollMs={5}
      autoRecheckMs={props.autoRecheckMs ?? 20}
      {...(props.autoRecheckMax
        ? { autoRecheckMax: props.autoRecheckMax }
        : {})}
      onChanged={onChanged}
      onClose={() => {}}
    />,
  );
  return within(screen.getByRole("dialog"));
}
const stepBar = (dialog: ReturnType<typeof within>) => {
  const items = within(
    dialog.getByRole("list", { name: "添加 worker 的步骤" }),
  ).getAllByRole("listitem");
  /** The step's name: without its marker and the screen-reader state. */
  const name = (li: HTMLElement) =>
    [...li.childNodes]
      .filter((n) => !(n instanceof HTMLElement && n.ariaHidden === "true"))
      .map((n) => n.textContent)
      .join("")
      .replace(/（已完成）|（未通过）|（未用到）/gu, "");
  return {
    names: items.map(name),
    current: items
      .filter((li) => li.getAttribute("aria-current") === "step")
      .map(name),
    done: items.filter((li) => li.textContent?.includes("（已完成）")).length,
    failed: items
      .filter((li) => li.textContent?.includes("（未通过）"))
      .map(name),
    skipped: items
      .filter((li) => li.textContent?.includes("（未用到）"))
      .map(name),
  };
};
async function toBlocked(
  dialog: ReturnType<typeof within>,
  values: WorkerWizardInput = input,
) {
  await fill(dialog, values);
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  fireEvent.click(await dialog.findByRole("button", { name: "确认写入配置" }));
  fireEvent.click(await dialog.findByRole("button", { name: "开始检查" }));
}

test("C-565: the whole wizard path is shown from the first screen, with the current step marked", async () => {
  const fake = backend(["resources", "account", "passed"]);
  const dialog = drawer(fake.client, { autoRecheckMs: 60_000 });
  expect(stepBar(dialog)).toEqual({
    names: ["填写", "预览确认", "9 项检查", "目标机命令", "开启远程派发"],
    current: ["填写"],
    done: 0,
    failed: [],
    skipped: [],
  });
  await fill(dialog);
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await dialog.findByRole("button", { name: "确认写入配置" });
  expect(stepBar(dialog).current).toEqual(["预览确认"]);
  expect(stepBar(dialog).done).toBe(1);
  fireEvent.click(dialog.getByRole("button", { name: "确认写入配置" }));
  await dialog.findByRole("button", { name: "开始检查" });
  expect(stepBar(dialog).current).toEqual(["9 项检查"]);
  fireEvent.click(dialog.getByRole("button", { name: "开始检查" }));
  // Stopped at the resources: still a check matter, shown as not passed.
  await dialog.findByRole("button", { name: "继续检查" });
  expect(stepBar(dialog)).toMatchObject({
    current: ["9 项检查"],
    failed: ["9 项检查"],
    done: 2,
  });
  fireEvent.click(dialog.getByRole("button", { name: "继续检查" }));
  // Stopped at the account: the commands are the step now, and the checks
  // are still not passed (never ticked as done).
  await waitFor(() => expect(stepBar(dialog).current).toEqual(["目标机命令"]));
  expect(stepBar(dialog)).toMatchObject({ failed: ["9 项检查"], done: 2 });
  fireEvent.click(dialog.getByRole("button", { name: "继续检查" }));
  await dialog.findByRole("button", { name: "复查" });
  expect(stepBar(dialog)).toMatchObject({
    current: ["开启远程派发"],
    failed: [],
    done: 4,
  });
  fireEvent.click(dialog.getByRole("button", { name: "预览开启" }));
  fireEvent.click(
    await dialog.findByRole("checkbox", { name: "我确认开启远程派发" }),
  );
  fireEvent.click(dialog.getByRole("button", { name: "开启远程派发" }));
  await dialog.findByText("已开启远程派发");
  expect(stepBar(dialog)).toMatchObject({ current: [], done: 5 });
});

test("C-565: every field says what it is and where to find it; inferable values are prefilled", async () => {
  const fake = backend([]);
  const defaults = Promise.withResolvers<{
    defaults: { mcp_url?: string };
  }>();
  const dialog = drawer({
    ...fake.client,
    workerWizardDefaults: vi.fn(() => defaults.promise),
  });
  const box = (name: string) =>
    dialog.getByRole("textbox", { name }) as HTMLInputElement;
  const hint = (name: string) => {
    const id = box(name).getAttribute("aria-describedby") ?? "";
    return document.getElementById(id)?.textContent ?? "";
  };
  // Port and the recommended account are already there.
  expect(box("SSH 端口").value).toBe("22");
  expect(box("专用账号").value).toBe("cg_p_1");
  expect(box("MCP 地址").value).toBe("");
  expect(hint("机器编号")).toContain("不能是 local");
  expect(hint("机器编号")).toContain("cardigan worker add");
  expect(hint("主机地址")).toContain("tailnet");
  expect(hint("专用账号")).toContain("cg_");
  expect(hint("UID")).toContain("getent passwd | cut -d: -f3 | sort -n");
  expect(hint("GID")).toContain("getent group | cut -d: -f3 | sort -n");
  expect(hint("MCP 地址")).toContain("只认 HTTPS 的 /mcp");
  // The host's known MCP address fills the empty field.
  await act(async () =>
    defaults.resolve({
      defaults: { mcp_url: "https://control.example.ts.net/mcp" },
    }),
  );
  expect(box("MCP 地址").value).toBe("https://control.example.ts.net/mcp");
  expect(hint("MCP 地址")).toContain("已填入现有 worker 使用的地址");
  // macOS: the commands that list taken numbers there; arm64 only.
  fireEvent.click(dialog.getByRole("button", { name: "macOS" }));
  expect(hint("UID")).toContain("dscl . -list /Users UniqueID");
  expect(hint("GID")).toContain("dscl . -list /Groups PrimaryGroupID");
  const os = screen
    .getByRole("dialog")
    .querySelector("[data-ui='toggle-group']");
  expect(
    document.getElementById(os?.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toContain("Apple Silicon");
  // A prefilled form only needs what cannot be inferred.
  fireEvent.click(dialog.getByRole("button", { name: "Linux" }));
  for (const [name, value] of [
    ["机器编号", "studio"],
    ["名称", "工作室"],
    ["主机地址", "worker.invalid"],
    ["UID", "1501"],
    ["GID", "1501"],
  ] as const)
    fireEvent.change(box(name), { target: { value } });
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await dialog.findByRole("button", { name: "确认写入配置" });
  expect(fake.client.createWorkerWizard).toHaveBeenCalledWith("p-1", {
    ...input,
    // Back from macOS the architecture stays arm64 (unchanged behaviour).
    arch: "arm64",
    account: "cg_p_1",
    mcp_url: "https://control.example.ts.net/mcp",
  });
});

test("C-565: a suggested MCP address never replaces one the reader typed", async () => {
  const fake = backend([]);
  const defaults = Promise.withResolvers<{
    defaults: { mcp_url?: string };
  }>();
  const dialog = drawer({
    ...fake.client,
    workerWizardDefaults: vi.fn(() => defaults.promise),
  });
  const mcp = dialog.getByRole("textbox", { name: "MCP 地址" });
  fireEvent.change(mcp, {
    target: { value: "https://other.example.ts.net/mcp" },
  });
  await act(async () =>
    defaults.resolve({
      defaults: { mcp_url: "https://control.example.ts.net/mcp" },
    }),
  );
  expect((mcp as HTMLInputElement).value).toBe(
    "https://other.example.ts.net/mcp",
  );
});

test("C-565: mistakes are shown beside their fields and the first one takes focus", async () => {
  const fake = backend([]);
  const dialog = drawer(fake.client);
  await fill(dialog, {
    ...input,
    uid: 12,
    mcp_url: "http://control.example.ts.net/mcp",
  });
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  const uid = dialog.getByRole("textbox", { name: "UID" });
  await waitFor(() => expect(document.activeElement).toBe(uid));
  expect(uid.getAttribute("aria-invalid")).toBe("true");
  const notes = (uid.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent);
  expect(notes).toContain("UID 须为不小于 501 的整数。");
  const mcp = dialog.getByRole("textbox", { name: "MCP 地址" });
  expect(mcp.getAttribute("aria-invalid")).toBe("true");
  expect(
    dialog.getByText(
      "MCP 地址须为 Tailscale Serve 的 HTTPS 地址：https://<主机>.<tailnet>.ts.net/mcp，可带端口，不带账号、查询参数。",
    ),
  ).toBeTruthy();
  expect(
    dialog.getByRole("textbox", { name: "GID" }).getAttribute("aria-invalid"),
  ).toBeNull();
  expect(fake.client.createWorkerWizard).not.toHaveBeenCalled();
  // Correcting a field takes its note down.
  fireEvent.change(uid, { target: { value: "1501" } });
  expect(uid.getAttribute("aria-invalid")).toBeNull();
  expect(dialog.queryByText("UID 须为不小于 501 的整数。")).toBeNull();
  expect(mcp.getAttribute("aria-invalid")).toBe("true");
});

test("C-565: after a stop the commands fix, the page checks again by itself and moves on", async () => {
  const fake = backend(["account", "account", "directories", "passed"]);
  const dialog = drawer(fake.client);
  await toBlocked(dialog);
  // account blocked → rechecked → still blocked → rechecked → next stop
  // (directories) → rechecked → all passed, without pressing anything.
  await dialog.findByRole("button", { name: "复查" }, { timeout: 3000 });
  expect(fake.writes).toEqual(["confirm", "run", "run", "run", "run"]);
  expect(stepBar(dialog).current).toEqual(["开启远程派发"]);
});

test("C-565: automatic rechecks stop at their limit; 继续检查 stays and starts them over", async () => {
  const fake = backend(["account", "account", "account", "account", "passed"]);
  const dialog = drawer(fake.client, { autoRecheckMax: 2 });
  await toBlocked(dialog);
  await dialog.findByText(
    "自动复查已停止：在目标机执行命令后，请点“继续检查”。",
    undefined,
    { timeout: 3000 },
  );
  expect(fake.writes).toEqual(["confirm", "run", "run", "run"]);
  await new Promise((done) => setTimeout(done, 100));
  expect(fake.writes).toHaveLength(4);
  fireEvent.click(dialog.getByRole("button", { name: "继续检查" }));
  await dialog.findByRole("button", { name: "复查" }, { timeout: 3000 });
  expect(fake.writes).toEqual(["confirm", "run", "run", "run", "run", "run"]);
});

test("C-565: a stop the commands do not fix (resources) waits for 继续检查", async () => {
  const fake = backend(["resources"]);
  const dialog = drawer(fake.client);
  await toBlocked(dialog);
  await dialog.findByRole("button", { name: "继续检查" });
  await new Promise((done) => setTimeout(done, 150));
  expect(fake.writes).toEqual(["confirm", "run"]);
  expect(dialog.queryByText(/自动复查/u)).toBeNull();
});

test("C-565: a first onboarding stops at SSH (no account yet) and is rechecked until the account works", async () => {
  const fake = backend(["ssh", "ssh", "passed"]);
  const dialog = drawer(fake.client);
  await toBlocked(dialog);
  await dialog.findByRole("button", { name: "复查" }, { timeout: 3000 });
  expect(fake.writes).toEqual(["confirm", "run", "run", "run"]);
  // Each automatic run named the failed check it continued.
  const runs = vi
    .mocked(fake.client.workerWizardAction)
    .mock.calls.map(([, , action]) => action)
    .filter((a) => a.kind === "run");
  expect(runs).toEqual([
    { kind: "run" },
    { kind: "run", resume_check_id: "check-1" },
    { kind: "run", resume_check_id: "check-2" },
  ]);
});

test("C-565: a late automatic recheck from a stale page reads the moved-on session instead of starting a check", async () => {
  const fake = backend(["account"]);
  const dialog = drawer(fake.client, { autoRecheckMs: 80 });
  await toBlocked(dialog);
  await dialog.findByText(/自动复查中/u);
  // Another page continued and passed the check, then previewed launch.
  fake.mutate((w) => ({
    ...w,
    phase: "passed",
    check_id: "check-other",
    steps: w.steps.map((s) => ({ ...s, state: "passed" })),
    preview: {
      preview_id: "pv-other",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      file: "runtime-workers.yaml",
      diff: [],
    },
  }));
  // The timer fires: refused, so this page shows where the session is.
  await dialog.findByRole("button", { name: "复查" }, { timeout: 3000 });
  expect(fake.writes).toEqual(["confirm", "run"]);
  expect(fake.current()?.preview?.preview_id).toBe("pv-other");
  expect(dialog.queryByRole("alert")).toBeNull();
});

test("C-565: an earlier blocked row left from a previous round does not keep the checks running", async () => {
  const fake = backend(["account"]);
  const dialog = drawer(fake.client, { autoRecheckMs: 60_000 });
  await toBlocked(dialog);
  await dialog.findByText(/自动复查中/u);
  cleanup();
  // This round stopped at the configuration check; account is left over.
  fake.mutate((w) => ({
    ...w,
    steps: w.steps.map((s) =>
      s.step === "configuration"
        ? { ...s, state: "blocked", reason: "worker_config_changed" }
        : s,
    ),
  }));
  window.localStorage.setItem(
    "cardigan.worker-wizard.p-1",
    fake.current()?.id ?? "",
  );
  const again = drawer(fake.client, { autoRecheckMs: 20 });
  await again.findByRole("table", { name: "接入步骤" });
  await new Promise((done) => setTimeout(done, 150));
  expect(fake.writes).toEqual(["confirm", "run"]);
  expect(again.queryByText(/自动复查/u)).toBeNull();
  expect(stepBar(again)).toMatchObject({
    current: ["9 项检查"],
    failed: ["9 项检查"],
  });
});

test("C-565: refusals the server ties to a field, and common address mistakes, show beside the field", async () => {
  const fake = backend([]);
  const create = fake.client.createWorkerWizard;
  fake.client.createWorkerWizard = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(400, "worker_mcp_url_invalid", "请核对向导配置"),
    )
    .mockImplementation(create);
  const dialog = drawer(fake.client);
  const box = (name: string) => dialog.getByRole("textbox", { name });
  await fill(dialog, { ...input, host: "worker.example.org:22" });
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await waitFor(() =>
    expect(box("主机地址").getAttribute("aria-invalid")).toBe("true"),
  );
  expect(
    dialog.getByText("主机地址不带端口，端口填在“SSH 端口”里。"),
  ).toBeTruthy();
  fireEvent.change(box("主机地址"), { target: { value: "admin@worker" } });
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await dialog.findByText("主机地址不带用户名，账号填在“专用账号”里。");
  expect(fake.client.createWorkerWizard).not.toHaveBeenCalled();
  fireEvent.change(box("主机地址"), { target: { value: "worker.invalid" } });
  // The server refuses the MCP address: the note is beside that field.
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await waitFor(() =>
    expect(box("MCP 地址").getAttribute("aria-invalid")).toBe("true"),
  );
  expect(dialog.queryByRole("alert")).toBeNull();
  fireEvent.change(box("MCP 地址"), {
    target: { value: "https://control.example.ts.net/mcp" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "预览配置" }));
  await dialog.findByRole("button", { name: "确认写入配置" });
});

test("C-565: the suggestions are a same-origin read of the owner's wizard defaults", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          defaults: { mcp_url: "https://control.example.ts.net/mcp" },
        }),
      ),
  );
  const http = new HttpCardiganClient(fetcher);
  expect(await http.workerWizardDefaults("p 1")).toEqual({
    defaults: { mcp_url: "https://control.example.ts.net/mcp" },
  });
  const [[url, init]] = fetcher.mock.calls as unknown as [
    string,
    RequestInit,
  ][];
  expect(url).toBe("/api/projects/p%201/worker-wizards/defaults");
  expect(init.method ?? "GET").toBe("GET");
  expect(init.credentials).toBe("same-origin");
});

test("C-565: the host's explicit remote MCP address is named as such", async () => {
  const fake = backend([]);
  const dialog = drawer({
    ...fake.client,
    workerWizardDefaults: vi.fn(async () => ({
      defaults: {
        mcp_url: "https://mcp.example.ts.net:8443/mcp",
        mcp_source: "host" as const,
      },
    })),
  });
  const mcp = dialog.getByRole("textbox", { name: "MCP 地址" });
  await waitFor(() =>
    expect((mcp as HTMLInputElement).value).toBe(
      "https://mcp.example.ts.net:8443/mcp",
    ),
  );
  expect(
    document.getElementById(mcp.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toContain("已填入控制主机配置的 MCP 地址");
});

test("C-565: checks that pass straight through leave the commands step as not needed, never ticked", async () => {
  const fake = backend(["passed"]);
  const dialog = drawer(fake.client);
  await toBlocked(dialog);
  await dialog.findByRole("button", { name: "复查" });
  expect(stepBar(dialog)).toMatchObject({
    current: ["开启远程派发"],
    done: 3,
    failed: [],
    skipped: ["目标机命令"],
  });
});

test("C-565: while rechecking, the status is short and counts the rechecks", async () => {
  const fake = backend(["account", "passed"]);
  const dialog = drawer(fake.client, { autoRecheckMs: 60_000 });
  await toBlocked(dialog);
  expect(await dialog.findByText("自动复查中（0/20）")).toBeTruthy();
});

test("C-565: the commands-step mark never touches another project's session, even one named <project>.commands", async () => {
  // Project "demo.commands" holds a session; project "demo" stops at a
  // target-machine step, then finishes.
  window.localStorage.setItem(
    "cardigan.worker-wizard.demo.commands",
    "6f1c2a7e-0000-4000-8000-0000000000aa",
  );
  const fake = backend(["account", "passed"]);
  render(
    <WorkerWizardDrawer
      client={fakeClient(fake.client)}
      projectId="demo"
      pollMs={5}
      autoRecheckMs={60_000}
      onChanged={() => {}}
      onClose={() => {}}
    />,
  );
  const dialog = within(screen.getByRole("dialog"));
  await toBlocked(dialog);
  await dialog.findByText(/自动复查中/u);
  expect(storedWizard("demo.commands")).toBe(
    "6f1c2a7e-0000-4000-8000-0000000000aa",
  );
  fireEvent.click(dialog.getByRole("button", { name: "继续检查" }));
  fireEvent.click(await dialog.findByRole("button", { name: "完成" }));
  await waitFor(() => expect(storedWizard("demo")).toBeUndefined());
  expect(storedWizard("demo.commands")).toBe(
    "6f1c2a7e-0000-4000-8000-0000000000aa",
  );
});

// C-707: device pairing (C-705 code, C-706 init script) in the wizard.
const deviceFacts = {
  hostname: "steamdeck",
  os: "linux" as const,
  arch: "x64" as const,
  address: "steamdeck.example.ts.net",
  free_id: 2000,
  system: "SteamOS 3.8",
  cpu: "AMD Custom APU 0405",
  cpu_cores: 8,
  memory_bytes: 16 * 1024 ** 3,
  disk_path: "/home",
  disk_total_bytes: 512 * 1024 ** 3,
  disk_free_bytes: 400 * 1024 ** 3,
};
function pairingBackend(runs: (WorkerWizardStep["step"] | "passed")[] = []) {
  const fake = backend(runs);
  const pairWorkerDevice = vi.fn(
    async (project: string, body: { code: string; run_limit: number }) => {
      if (body.code === "EXP2RED2")
        throw new ApiError(410, "pairing_code_expired", "配对码已过期");
      if (body.code === "MANY2222")
        throw new ApiError(429, "pairing_rate_limited", "错误次数过多");
      if (body.run_limit > 16)
        throw new ApiError(
          400,
          "worker_run_limit_invalid",
          "名额须为 1～16 的整数",
          false,
          { maximum: 16 },
        );
      await fake.client.createWorkerWizard(project, {
        ...input,
        machine_id: "steamdeck",
        label: "steamdeck",
      });
      fake.mutate((w) => ({
        ...w,
        project_id: project,
        device_init: { state: "waiting" },
        device: deviceFacts,
        run_limit: { value: body.run_limit, state: "pending" },
      }));
      return {
        wizard: fake.current() as WorkerWizardView,
        device: deviceFacts,
      };
    },
  );
  const read = fake.client.workerWizard;
  const workerWizard = vi.fn(async (p: string, id: string) => {
    const reply = await read(p, id);
    return reply.wizard.phase === "passed"
      ? {
          wizard: {
            ...reply.wizard,
            run_limit: { value: 1, state: "applied" as const },
            report: {
              capabilities: [
                {
                  key: "node",
                  version: "24.1.0",
                  verified_at: "2026-01-01T00:00:00.000Z",
                  state: "verified" as const,
                },
                {
                  key: "godot",
                  version: null,
                  verified_at: null,
                  state: "unverified" as const,
                },
              ],
              suggested: ["godot", "blender"],
            },
          },
        }
      : reply;
  });
  return {
    ...fake,
    client: { ...fake.client, pairWorkerDevice, workerWizard },
    pairWorkerDevice,
  };
}
const field = (dialog: ReturnType<typeof within>, name: string) =>
  dialog.getByRole("textbox", { name }) as HTMLInputElement;

test("C-707: pairing shows its steps and field hints first; code, project and limit go together with 确认接入", async () => {
  const fake = pairingBackend(["passed"]);
  page(fake.client);
  fireEvent.click(
    await screen.findByRole("button", { name: "新设备接入（配对码）" }),
  );
  const dialog = within(await screen.findByRole("dialog"));
  const steps = dialog.getByRole("list", { name: "添加 worker 的步骤" });
  expect(within(steps).getAllByRole("listitem")[0]?.textContent).toBe(
    "1配对确认",
  );
  expect(
    within(steps).getAllByRole("listitem")[0]?.getAttribute("aria-current"),
  ).toBe("step");
  expect(field(dialog, "配对码").value).toBe("");
  expect(field(dialog, "名额").value).toBe("1");
  expect(dialog.getByRole("combobox", { name: /项目/u }).textContent).toContain(
    "Cardigan 自己",
  );
  // Each field says what it is; the device command is right there.
  expect(field(dialog, "配对码").getAttribute("aria-describedby")).toBeTruthy();
  expect(dialog.getByText(/pair-device\.py \| python3 -/u)).toBeTruthy();
  dialog.getByText(/之后可在机器详情修改/u);

  // A malformed code or limit is shown beside its field; nothing is sent.
  fireEvent.change(field(dialog, "配对码"), { target: { value: "abc" } });
  fireEvent.change(field(dialog, "名额"), { target: { value: "0" } });
  fireEvent.click(dialog.getByRole("button", { name: "确认接入" }));
  await dialog.findByText(
    "配对码为设备上显示的 8 位字母和数字，如 ABCD-EFGH。",
  );
  dialog.getByText("名额须为正整数。");
  expect(fake.pairWorkerDevice).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(document.activeElement).toBe(field(dialog, "配对码")),
  );

  fireEvent.change(field(dialog, "配对码"), { target: { value: "abcd efgh" } });
  fireEvent.change(field(dialog, "名额"), { target: { value: "1" } });
  fireEvent.click(dialog.getByRole("button", { name: "确认接入" }));
  await dialog.findByRole("button", { name: "确认写入配置" });
  expect(fake.pairWorkerDevice).toHaveBeenCalledWith("p-1", {
    code: "ABCDEFGH",
    run_limit: 1,
  });
  expect(storedWizard("p-1")).toBe(fake.current()?.id);
  const done = within(steps).getAllByRole("listitem")[0];
  expect(done?.getAttribute("data-state")).toBe("done");
  dialog.getByText("等待设备");
  dialog.getByText("1 个（登记后生效）");
  // Remote launch is not offered before the checks pass.
  expect(dialog.queryByText("远程派发")).toBeNull();
});

test("C-707: the device's init report starts the recheck; the passed wizard shows the report before the separate remote-launch step", async () => {
  const fake = pairingBackend(["passed"]);
  render(
    <WorkerWizardDrawer
      client={fakeClient(fake.client)}
      projectId="p-1"
      pairing={{ code: "ABCD-EFGH" }}
      onClose={() => undefined}
      onChanged={() => undefined}
      pollMs={5}
      devicePollMs={5}
    />,
  );
  const dialog = within(await screen.findByRole("dialog"));
  expect(field(dialog, "配对码").value).toBe("ABCD-EFGH");
  fireEvent.click(dialog.getByRole("button", { name: "确认接入" }));
  fireEvent.click(await dialog.findByRole("button", { name: "确认写入配置" }));
  await dialog.findByRole("button", { name: "开始检查" });
  // The device fetched and ran its script; the server started the recheck.
  fake.mutate((w) => ({
    ...w,
    device_init: { state: "succeeded", at: "2026-01-01T00:00:00.000Z" },
    phase: "running",
    check_id: "check-device",
  }));
  await dialog.findByRole("button", { name: "复查" });
  const report = await dialog.findByRole("table", { name: "体检报告" });
  const rows = within(report)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );
  expect(rows).toEqual([
    ["系统", "SteamOS 3.8 · linux / x64", "设备自报"],
    ["CPU", "AMD Custom APU 0405 · 8 核", "设备自报"],
    ["内存", "16.0 GiB", "设备自报"],
    ["磁盘", "可用 400 GiB / 共 512 GiB（/home）", "设备自报"],
    ["GPU", "—", "设备未上报"],
    ["已验证能力", "node 24.1.0", "接入检查"],
    ["建议安装的工具", "godot、blender", "能力目录"],
  ]);
  dialog.getByText("已完成");
  dialog.getByText("1 个");
  // The report comes before the remote-launch group, which stays last.
  const launch = dialog.getByText("需谨慎");
  expect(
    report.compareDocumentPosition(launch) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(dialog.getByText("未开启")).toBeTruthy();
  expect(fake.writes).not.toContain("enable");
});

test("C-707: refused codes and limits are explained beside their fields with what to do next", async () => {
  const fake = pairingBackend();
  render(
    <WorkerWizardDrawer
      client={fakeClient(fake.client)}
      projectId="p-1"
      pairing={{ code: undefined }}
      onClose={() => undefined}
      onChanged={() => undefined}
    />,
  );
  const dialog = within(await screen.findByRole("dialog"));
  const send = (code: string, limit = "1") => {
    fireEvent.change(field(dialog, "配对码"), { target: { value: code } });
    fireEvent.change(field(dialog, "名额"), { target: { value: limit } });
    fireEvent.click(dialog.getByRole("button", { name: "确认接入" }));
  };
  send("EXP2-RED2");
  await dialog.findByText(
    "配对码已过期（10 分钟内有效），请在设备上重新运行命令获取新码。",
  );
  expect(field(dialog, "配对码").getAttribute("aria-invalid")).toBe("true");
  send("ABCD-EFGH", "17");
  await dialog.findByText("名额须为 1～16 的整数。");
  send("MANY-2222");
  await screen.findByText("配对码错误次数过多，请稍后再试。");
  // Still the pairing step: nothing became a draft.
  expect(dialog.getByRole("button", { name: "确认接入" })).toBeTruthy();
  expect(storedWizard("p-1")).toBeUndefined();
});

test("C-707: a code confirmed for another project continues that project's session", async () => {
  const fake = pairingBackend();
  const other = { id: "p-2", name: "另一个项目", created_at: "", code: "OT" };
  window.localStorage.setItem("cardigan.worker-wizard.p-1", "kept-session");
  render(
    <WorkerWizardDrawer
      client={fakeClient({
        ...fake.client,
        projects: async () => [
          { id: "p-1", name: "Cardigan 自己", created_at: "" },
          other,
        ],
      })}
      projectId="p-1"
      pairing={{ code: "ABCD-EFGH" }}
      onClose={() => undefined}
      onChanged={() => undefined}
    />,
  );
  const dialog = within(await screen.findByRole("dialog"));
  // The held session of this project would be replaced: said before sending.
  dialog.getByText("确认后将替换这个项目未完成的添加 worker 进度。");
  await dialog.findByText("另一个项目（OT）", { selector: "option" });
  changeControl(dialog.getByRole("combobox", { name: /项目/u }), {
    target: { value: "p-2" },
  });
  await waitFor(() =>
    expect(
      dialog.queryByText("确认后将替换这个项目未完成的添加 worker 进度。"),
    ).toBeNull(),
  );
  fireEvent.click(dialog.getByRole("button", { name: "确认接入" }));
  fireEvent.click(await dialog.findByRole("button", { name: "确认写入配置" }));
  await dialog.findByRole("button", { name: "开始检查" });
  expect(fake.pairWorkerDevice.mock.calls[0]?.[0]).toBe("p-2");
  expect(fake.client.workerWizardAction.mock.calls.at(-1)?.[0]).toBe("p-2");
  expect(storedWizard("p-2")).toBe(fake.current()?.id);
  expect(storedWizard("p-1")).toBe("kept-session");
});

test("C-707: a QR link's code leaves the address bar at once and opens the pairing step filled in", async () => {
  const { capturePairingLink, pendingPairingCode } = await import(
    "../pairing-link.js"
  );
  window.history.replaceState(null, "", "/#/pair/ABCD-EFGH");
  const push = vi.spyOn(window.history, "pushState");
  const length = window.history.length;
  capturePairingLink();
  expect(window.location.hash).toBe("");
  expect(window.history.length).toBe(length);
  expect(push).not.toHaveBeenCalled();
  expect(pendingPairingCode()).toBe("ABCD-EFGH");
  const fake = pairingBackend();
  page(fake.client);
  const dialog = within(await screen.findByRole("dialog"));
  expect(field(dialog, "配对码").value).toBe("ABCD-EFGH");
  // Taken once; confirming is still the reader's own step.
  expect(pendingPairingCode()).toBeUndefined();
  expect(fake.pairWorkerDevice).not.toHaveBeenCalled();
  push.mockRestore();
});
