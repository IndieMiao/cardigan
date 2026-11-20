import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRuntimeWorkers,
  WORKER_STEPS,
  type WorkerProbeRunner,
} from "@cardigan/host";
import { hashWebSessionToken } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  m5Cross,
  type ResponseBody,
  TEST_PASSWORD,
} from "../../test-support/m5-cross.js";

const form = {
  machine_id: "worker-a",
  label: "新机器",
  os: "linux",
  arch: "x64",
  host: "hidden.example.invalid",
  account: "cg_demo",
  uid: 2600,
  gid: 2600,
  mcp_url: "https://private.example.ts.net/mcp",
};
async function fixture(probe: WorkerProbeRunner = async () => true) {
  const root = mkdtempSync(join(tmpdir(), "wizard-")),
    dataDir = "/private/controller",
    refresh = vi.fn(async () => {});
  const f = await m5Cross({
    machineHost: {
      bindings: () => () => null,
      workerRecord: () => null,
      check: async () => {
        throw new Error("unexpected");
      },
      wizard: { root, dataDir, env: {}, probe, refresh },
    },
  });
  const base = f.projectPath("/worker-wizards");
  const post = (suffix: string, body: unknown = {}) =>
    f.call(`${base}${suffix}`, { method: "POST", body });
  return {
    ...f,
    root,
    base,
    post,
    dataDir,
    refresh,
    close: async () => {
      try {
        await f.close();
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  };
}
function wizard(response: ResponseBody, status = 200) {
  expect(response.status, response.text).toBe(status);
  return (
    response.json as {
      wizard: {
        id: string;
        phase: string;
        preview: { preview_id: string; diff: unknown[] };
        commands: Record<string, string>;
        steps: {
          step: string;
          state: string;
          elapsed_ms: number;
          next?: string;
          reason?: string;
          command_key?: string;
        }[];
      };
    }
  ).wizard;
}
test.runIf(process.platform === "linux")(
  "only current human owner can preview/confirm; cancel, replaced, expired and changed previews have no write effect",
  async () => {
    const f = await fixture();
    try {
      const bearer = { authorization: `Bearer ${f.token(f.primary.owner)}` };
      expect((await f.post("", form)).status).toBe(401);
      await f.password(TEST_PASSWORD);
      await f.login();
      expect(
        (await f.call(f.base, { method: "POST", body: form, headers: bearer }))
          .status,
      ).toBe(403);
      expect(
        (await f.post("", { ...form, allow_remote_launch: true })).status,
      ).toBe(400);
      expect(
        (
          await f.call(f.base, {
            method: "POST",
            body: form,
            headers: { origin: "https://untrusted.invalid" },
          })
        ).status,
      ).toBe(403);
      expect(
        (await f.post("", { ...form, account: "invalid account" })).status,
      ).toBe(400);
      const make = async () => wizard(await f.post("", form), 201);
      const first = await make();
      const second = await make();
      expect((await f.post(`/${first.id}/confirm`, first.preview)).status).toBe(
        404,
      );
      expect((await f.post(`/${second.id}/cancel`)).status).toBe(200);
      expect((await f.call(`${f.base}/${second.id}`)).status).toBe(404);
      const third = await make();
      f.advance(900_001);
      expect(
        (
          await f.post(`/${third.id}/confirm`, {
            preview_id: third.preview.preview_id,
          })
        ).status,
      ).toBe(409);
      const s = await make();
      for (const [action, body] of [
        ["confirm", { preview_id: s.preview.preview_id }],
        ["run", {}],
        [
          "enable",
          { preview_id: s.preview.preview_id, allow_remote_launch: true },
        ],
      ] as const) {
        expect(
          (
            await f.call(`${f.base}/${s.id}/${action}`, {
              method: "POST",
              body,
              headers: bearer,
            })
          ).status,
        ).toBe(403);
      }
      f.store().createProject({ id: "other" });
      expect(
        (await f.call(`/api/projects/other/worker-wizards/${s.id}`)).status,
      ).toBe(404);
      const cookie = f.store().createWebSession();
      f.store().uow.run((tx) =>
        tx.members.put({
          id: "M-2",
          name: "Observer",
          title: "Observer",
          avatar: null,
          role: "observer",
          status: "active",
          created_at: cookie.session.created_at,
          updated_at: cookie.session.created_at,
        }),
      );
      f.store()
        .database.prepare("UPDATE web_sessions SET member_id=? WHERE id_hash=?")
        .run("M-2", hashWebSessionToken(cookie.token));
      expect(
        (
          await f.call(`${f.base}/${s.id}/confirm`, {
            method: "POST",
            body: { preview_id: s.preview.preview_id },
            headers: { cookie: `cardigan_session=${cookie.token}` },
          })
        ).status,
      ).toBe(403);
      expect(readdirSync(f.root)).toEqual([]);
    } finally {
      await f.close();
    }
  },
);
test.runIf(process.platform === "linux")(
  "polls individual steps, resumes at failure; separate exact launch preview, private backups, audit without endpoints",
  async () => {
    let repaired = false;
    const gate = Promise.withResolvers<void>();
    const probe = vi.fn<WorkerProbeRunner>(async (step) => {
      if (step === "account") {
        await gate.promise;
        return repaired;
      }
      return true;
    });
    const f = await fixture(probe);
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const runtime = join(f.root, "runtime-workers.yaml");
      const original = "# keep host comment\nversion: 1\nmachines: []\n";
      writeFileSync(runtime, original, { mode: 0o600 });
      const preview = await f.post("", form);
      const s = wizard(preview, 201);
      const path = `/${s.id}`;
      expect(preview.text).not.toMatch(
        /hidden.example|private.example|worker-key|worker-known-hosts/,
      );
      expect(s.preview.diff.length).toBeGreaterThan(0);
      const draft = join(
        f.root,
        `worker-${form.machine_id}-${f.project.project_id}.yaml`,
      );
      expect(existsSync(draft)).toBe(false);
      expect((await f.post(`${path}/run`)).status).toBe(409);
      const confirm = { preview_id: s.preview.preview_id };
      expect(
        (
          await f.post(`${path}/enable`, {
            ...confirm,
            allow_remote_launch: true,
          })
        ).status,
      ).toBe(409);
      expect((await f.post(`${path}/confirm`, confirm)).status).toBe(200);
      expect(statSync(draft).mode & 0o777).toBe(0o600);
      expect(readFileSync(runtime, "utf8")).toBe(original);
      const run = () => f.post(`${path}/run`);
      const status = async () => wizard(await f.call(f.base + path));
      expect((await run()).status).toBe(202);
      expect((await status()).steps).toContainEqual(
        expect.objectContaining({ step: "account", state: "running" }),
      );
      expect((await run()).status).toBe(409);
      gate.resolve();
      await vi.waitFor(async () =>
        expect((await status()).phase).toBe("failed"),
      );
      expect((await status()).steps).toContainEqual(
        expect.objectContaining({
          step: "account",
          state: "blocked",
          reason: "worker_account_blocked",
          next: expect.any(String),
          elapsed_ms: expect.any(Number),
        }),
      );
      expect((await f.post(`${path}/launch-preview`)).status).toBe(409);
      repaired = true;
      expect((await run()).status).toBe(202);
      await vi.waitFor(async () =>
        expect((await status()).phase).toBe("passed"),
      );
      expect(probe.mock.calls.map((c) => c[0])).toEqual([
        "ssh",
        "account",
        "account",
        ...WORKER_STEPS.slice(4),
      ]);
      expect(
        f
          .store()
          .uow.read((tx) =>
            tx.machines.get(f.project.project_id, form.machine_id),
          ),
      ).toMatchObject({ label: form.label, status: "offline" });
      expect(readFileSync(runtime, "utf8")).toBe(original);
      const launchPreview = async () => ({
        preview_id: wizard(await f.post(`${path}/launch-preview`)).preview
          .preview_id,
        allow_remote_launch: true,
      });
      const first = await launchPreview();
      expect(
        (
          await f.post(`${path}/enable`, {
            ...first,
            allow_remote_launch: false,
          })
        ).status,
      ).toBe(400);
      const changed = `${original}# another operator\n`;
      writeFileSync(runtime, changed);
      expect((await f.post(`${path}/enable`, first)).status).toBe(409);
      expect(readFileSync(runtime, "utf8")).toBe(changed);
      const current = await launchPreview();
      expect((await f.post(`${path}/enable`, first)).status).toBe(409);
      expect(wizard(await f.post(`${path}/enable`, current)).phase).toBe(
        "enabled",
      );
      expect(loadRuntimeWorkers(f.dataDir, runtime)).toMatchObject([
        { machine_id: form.machine_id, allow_remote_launch: true },
      ]);
      const backups = readdirSync(f.root).filter((n) => n.endsWith(".bak"));
      expect(backups).toHaveLength(1);
      const backup = join(f.root, String(backups[0]));
      expect(readFileSync(backup, "utf8")).toBe(changed);
      expect(statSync(backup).mode & 0o777).toBe(0o600);
      const events = f
        .store()
        .uow.read((tx) => tx.global_events.listAfter(0))
        .filter((e) => e.type.startsWith("worker_wizard_"));
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining([
          "worker_wizard_config_written",
          "worker_wizard_check_requested",
          "worker_wizard_check_finished",
          "worker_wizard_enable_failed",
          "worker_wizard_launch_enabled",
        ]),
      );
      expect(JSON.stringify([events, f.logs])).not.toMatch(
        /hidden.example|private.example|worker-key|cg_demo/,
      );
    } finally {
      gate.resolve();
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux")(
  "changed confirmed configuration blocks preflight visibly and records the same failure in the audit",
  async () => {
    const probe = vi.fn<WorkerProbeRunner>(async () => true),
      f = await fixture(probe);
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const s = wizard(await f.post("", form), 201);
      const path = `/${s.id}`;
      wizard(
        await f.post(`${path}/confirm`, { preview_id: s.preview.preview_id }),
      );
      const file = join(
        f.root,
        `worker-${form.machine_id}-${f.project.project_id}.yaml`,
      );
      writeFileSync(file, `${readFileSync(file, "utf8")}\ntimeout_ms: 4500\n`);
      expect((await f.post(`${path}/run`)).status).toBe(202);
      await vi.waitFor(async () => {
        const result = wizard(await f.call(f.base + path));
        expect(result.phase).toBe("failed");
        const step = result.steps.find((s) => s.step === "configuration");
        expect(step).toMatchObject({
          state: "blocked",
          reason: "worker_config_changed",
          elapsed_ms: expect.any(Number),
          next: expect.stringContaining("重新预览"),
        });
        const audit = f
          .store()
          .uow.read((tx) => tx.global_events.listAfter(0))
          .find((e) => e.type === "worker_wizard_check_finished");
        expect(audit?.payload).toMatchObject({
          failed_steps: ["configuration"],
          failure: {
            step: "configuration",
            reason: "worker_config_changed",
            elapsed_ms: step?.elapsed_ms,
            next: expect.stringContaining("重新预览"),
          },
        });
      });
      expect(probe).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux").each(["linux", "macos"])(
  "%s: a blocked helper step refers to the guarded command without supplying a second installer",
  async (os) => {
    const f = await fixture(async (step) => step !== "helpers");
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const s = wizard(await f.post("", { ...form, os, arch: "arm64" }), 201),
        path = `/${s.id}`;
      wizard(
        await f.post(`${path}/confirm`, { preview_id: s.preview.preview_id }),
      );
      expect((await f.post(`${path}/run`)).status).toBe(202);
      await vi.waitFor(async () => {
        const result = wizard(await f.call(f.base + path));
        expect(result.phase).toBe("failed");
        const step = result.steps.find((s) => s.step === "helpers");
        expect(step).toMatchObject({
          state: "blocked",
          command_key: "helpers",
          next: expect.stringContaining("不要覆盖"),
        });
        expect(step?.next).not.toContain("sudo");
        expect(result.commands[String(step?.command_key)]).toContain(
          "sudo cmp -s",
        );
      });
    } finally {
      await f.close();
    }
  },
);
