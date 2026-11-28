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
import { setImmediate as tick } from "node:timers/promises";
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

import { ProfileChecks } from "./launch-settings-check.js";

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
async function fixture(
  probe: WorkerProbeRunner = async () => true,
  withLaunchSettings = false,
  env: NodeJS.ProcessEnv = {},
) {
  const root = mkdtempSync(join(tmpdir(), "wizard-")),
    dataDir = "/private/controller",
    refresh = vi.fn(async () => {});
  const f = await m5Cross({
    ...(withLaunchSettings
      ? {
          launchSettings: {
            dir: root,
            effective: () => ({ profiles: {}, providers: {} }),
            adopt() {},
          },
        }
      : {}),
    machineHost: {
      bindings: () => () => null,
      workerRecord: () => null,
      check: async () => {
        throw new Error("unexpected");
      },
      wizard: { root, dataDir, env, probe, refresh },
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
    restart: f.restart,
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
        check_id?: string;
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
      // C-565: no worker uses an MCP address yet, so nothing is suggested.
      const defaults = async () => {
        const r = await f.call(`${f.base}/defaults`);
        expect(r.status, r.text).toBe(200);
        return (r.json as { defaults: { mcp_url?: string } }).defaults;
      };
      expect(await defaults()).toEqual({});
      expect((await f.post("/defaults")).status).toBe(405);
      expect(
        (
          await f.call(`${f.base}/defaults`, {
            headers: {
              authorization: `Bearer ${f.token(f.primary.owner)}`,
            },
          })
        ).status,
      ).toBe(403);
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
      // C-565: a late automatic recheck meeting a running check is told the
      // session moved on (not a preview error), and starts nothing.
      const whileRunning = await f.post(`${path}/run`, {
        resume_check_id: (await status()).check_id,
      });
      expect(whileRunning.status).toBe(409);
      expect(whileRunning.text).toContain("worker_check_changed");
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
      // C-565: an automatic recheck names the failed check it continues;
      // another check id (a stale page) is refused without starting one.
      const failedCheck = (await status()).check_id;
      expect(failedCheck).toEqual(expect.any(String));
      const resume = (id: unknown) =>
        f.post(`${path}/run`, { resume_check_id: id });
      expect((await resume(42)).status).toBe(400);
      const moved = await resume("another-check");
      expect(moved.status).toBe(409);
      expect(moved.text).toContain("worker_check_changed");
      expect((await status()).phase).toBe("failed");
      expect((await resume(failedCheck)).status).toBe(202);
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
      // A late automatic recheck of the earlier failure cannot restart the
      // passed check, so it cannot drop a launch preview another page holds.
      const held = (await f.post(`${path}/launch-preview`)).json as {
        wizard: { preview: { preview_id: string } };
      };
      const late = await resume(failedCheck);
      expect(late.status).toBe(409);
      expect(late.text).toContain("worker_check_changed");
      expect((await status()).phase).toBe("passed");
      expect((await status()).preview.preview_id).toBe(
        held.wizard.preview.preview_id,
      );
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
      // The address the enabled binding uses is now offered to the next form.
      expect(await defaults()).toEqual({
        mcp_url: form.mcp_url,
        mcp_source: "workers",
      });

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

test
  .runIf(process.platform === "linux")
  .each(["wizard", "profile", "HTTP read"])(
  "an audit write failure does not release the store before the last %s finishes",
  async (last) => {
    const worker = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    const f = await fixture(async (step) => {
      if (step === "account") {
        started.resolve();
        await worker.promise;
      }
      return true;
    }, true);
    const cli = vi
      .spyOn(ProfileChecks.prototype, "cli")
      .mockResolvedValue({ path: null, version: null });
    const drain = vi.spyOn(ProfileChecks.prototype, "drain");
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const s = wizard(await f.post("", form), 201);
      wizard(
        await f.post(`/${s.id}/confirm`, { preview_id: s.preview.preview_id }),
      );
      expect((await f.post(`/${s.id}/run`)).status).toBe(202);
      await started.promise;
      writeFileSync(
        join(f.root, "launch.yaml"),
        "profiles:\n  first: {harness: pi, model: fixture}\n  second: {harness: pi, model: fixture}\n",
        { mode: 0o600 },
      );
      const detail = await f.call("/api/launch-settings");
      expect(detail.status).toBe(200);
      const { version } = detail.json as { version: string };
      for (const [profile, gate] of [
        ["first", first],
        ["second", second],
      ] as const) {
        cli.mockImplementationOnce(async () => {
          await gate.promise;
          return { path: null, version: null };
        });
        expect(
          (
            await f.call("/api/launch-settings/checks", {
              method: "POST",
              body: { version, profile, mode: "metadata" },
            })
          ).status,
        ).toBe(202);
      }
      let reading: Promise<ResponseBody> | undefined;
      if (last === "HTTP read") {
        const entered = Promise.withResolvers<void>();
        cli.mockImplementationOnce(async () => {
          entered.resolve();
          await read.promise;
          return { path: null, version: null };
        });
        reading = f.call("/api/launch-settings");
        await entered.promise;
      }
      // Fail only the first audit; no sleeps, production timeout changes or repeated probes.
      const db = f.store().database;
      let attempts = 0;
      db.function("count_attempt", () => ++attempts);
      db.exec(`CREATE TRIGGER fail_first BEFORE UPDATE ON launch_profile_checks WHEN OLD.profile='first'
        BEGIN SELECT count_attempt(); SELECT RAISE(ABORT, 'fixture audit failed'); END;`);
      let settled = false;
      const outcome = f.web
        .close()
        .then(
          () => null,
          (reason: unknown) => reason,
        )
        .finally(() => {
          settled = true;
        });
      if (!reading)
        await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
      first.resolve();
      if (last !== "profile") second.resolve();
      if (last !== "wizard") worker.resolve();
      await tick();
      expect(attempts).toBe(1);
      expect(settled).toBe(false);
      if (reading) {
        expect(drain).not.toHaveBeenCalled();
        read.resolve();
        expect((await reading).status).toBe(200);
      }
      worker.resolve();
      second.resolve();
      expect(await outcome).toMatchObject({ message: "fixture audit failed" });
      expect(attempts).toBe(1);
      expect(
        db
          .prepare(
            "SELECT profile, finished_at IS NOT NULL AS done FROM launch_profile_checks ORDER BY profile",
          )
          .all(),
      ).toEqual([
        { profile: "first", done: 0 },
        { profile: "second", done: 1 },
      ]);
      expect(
        db
          .prepare("SELECT status FROM machine_check_jobs WHERE machine_id=?")
          .get(form.machine_id),
      ).toMatchObject({ status: "failed" });
      expect(
        f
          .store()
          .uow.read((tx) => tx.global_events.listAfter(0))
          .filter((e) => e.type === "worker_wizard_check_finished"),
      ).toHaveLength(1);
    } finally {
      read.resolve();
      first.resolve();
      second.resolve();
      worker.resolve();
      try {
        await f.close();
      } catch (err) {
        // close() keeps the original rejection on subsequent calls.
        f.store().close();
        expect(err).toMatchObject({ message: "fixture audit failed" });
      } finally {
        cli.mockRestore();
        drain.mockRestore();
      }
    }
  },
);

test.runIf(process.platform === "linux")(
  "C-565: with no worker bindings yet, an explicit remote MCP address is suggested; a loopback one never is",
  async () => {
    for (const [value, expected] of [
      [
        "https://mcp.example.ts.net:8443/mcp",
        {
          mcp_url: "https://mcp.example.ts.net:8443/mcp",
          mcp_source: "host",
        },
      ],
      ["http://127.0.0.1:3004/mcp", {}],
      ["https://user:secret@mcp.example.ts.net/mcp", {}],
    ] as const) {
      const f = await fixture(async () => true, false, {
        CARDIGAN_MCP_URL: value,
      });
      try {
        await f.password(TEST_PASSWORD);
        await f.login();
        const r = await f.call(`${f.base}/defaults`);
        expect(r.status, r.text).toBe(200);
        expect((r.json as { defaults: unknown }).defaults).toEqual(expected);
      } finally {
        await f.close();
      }
    }
  },
);

const draftFile = (f: { root: string; project: { project_id: string } }) =>
  join(f.root, `worker-${form.machine_id}-${f.project.project_id}.yaml`);
const binding = (file: string) => {
  const text = readFileSync(file, "utf8");
  const root = /\n\s+root: (\S+)/u.exec(text)?.[1];
  const files = /\n\s+file_helper: (\S+)/u.exec(text)?.[1];
  const git = /\n\s+git_helper: (\S+)/u.exec(text)?.[1];
  return { root, file_helper: files, git_helper: git };
};

test.runIf(process.platform === "linux")(
  "C-846: a session continues from its step after the server restarts at any step",
  async () => {
    const gate = Promise.withResolvers<void>();
    let hold = true;
    const probe = vi.fn<WorkerProbeRunner>(async (step) => {
      if (step === "account" && hold) {
        hold = false;
        await gate.promise;
      }
      return true;
    });
    const f = await fixture(probe);
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const s = wizard(await f.post("", form), 201);
      const path = `/${s.id}`;
      const status = async () => wizard(await f.call(f.base + path));
      // Restart while the preview waits for confirmation.
      await f.restart();
      const kept = await status();
      expect(kept.phase).toBe("preview");
      expect(kept.preview.preview_id).toBe(s.preview.preview_id);
      expect(
        (await f.post(`${path}/confirm`, { preview_id: s.preview.preview_id }))
          .status,
      ).toBe(200);
      await f.restart();
      expect((await status()).phase).toBe("ready");
      // Restart while the check runs: it did not finish, so it is failed and
      // continues with another check.
      expect((await f.post(`${path}/run`)).status).toBe(202);
      expect((await status()).phase).toBe("running");
      const restarting = f.restart();
      gate.resolve();
      await restarting;
      const interrupted = await status();
      expect(interrupted.phase).toBe("failed");
      expect(interrupted.steps.some((step) => step.state === "running")).toBe(
        false,
      );
      expect((await f.post(`${path}/run`)).status).toBe(202);
      await vi.waitFor(async () =>
        expect((await status()).phase).toBe("passed"),
      );
      await f.restart();
      expect((await status()).phase).toBe("passed");
      const launch = wizard(await f.post(`${path}/launch-preview`)).preview;
      // The launch preview survives a restart too.
      await f.restart();
      expect((await status()).preview.preview_id).toBe(launch.preview_id);
      expect(
        wizard(
          await f.post(`${path}/enable`, {
            preview_id: launch.preview_id,
            allow_remote_launch: true,
          }),
        ).phase,
      ).toBe("enabled");
      expect(
        loadRuntimeWorkers(f.dataDir, join(f.root, "runtime-workers.yaml")),
      ).toMatchObject([
        { machine_id: form.machine_id, allow_remote_launch: true },
      ]);
      await f.restart();
      expect((await status()).phase).toBe("enabled");
      // Expiry still applies: the session is gone after 24 hours.
      f.advance(86_400_001);
      await f.restart();
      expect((await f.call(f.base + path)).status).toBe(404);
      expect(
        f
          .store()
          .database.prepare("SELECT COUNT(*) AS n FROM worker_wizard_sessions")
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      gate.resolve();
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux")(
  "C-846: a cancelled session stays cancelled after a restart",
  async () => {
    const f = await fixture();
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const s = wizard(await f.post("", form), 201);
      expect((await f.post(`/${s.id}/cancel`)).status).toBe(200);
      await f.restart();
      expect((await f.call(`${f.base}/${s.id}`)).status).toBe(404);
    } finally {
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux")(
  "C-846: entering the wizard again keeps a written draft's SteamOS /home layout; a /srv draft stays /srv",
  async () => {
    const f = await fixture();
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const project = f.project.project_id;
      const home = `/home/cardigan-workers/${project}`;
      const first = wizard(await f.post("", { ...form, layout: "home" }), 201);
      wizard(
        await f.post(`/${first.id}/confirm`, {
          preview_id: first.preview.preview_id,
        }),
      );
      const written = binding(draftFile(f));
      expect(written).toEqual({
        root: home,
        file_helper: `${home}/libexec/worker-files.py`,
        git_helper: `${home}/libexec/worker-git.py`,
      });
      // The plain form (no layout field) over the same machine.
      const again = wizard(await f.post("", form), 201);
      expect(again.preview.diff).toEqual([]);
      expect(again.commands.directories).toContain(home);
      expect(again.commands.directories).not.toContain("/srv/");
      wizard(
        await f.post(`/${again.id}/confirm`, {
          preview_id: again.preview.preview_id,
        }),
      );
      expect(binding(draftFile(f))).toEqual(written);
      // An ordinary Linux draft keeps /srv.
      rmSync(draftFile(f));
      const plain = wizard(await f.post("", form), 201);
      wizard(
        await f.post(`/${plain.id}/confirm`, {
          preview_id: plain.preview.preview_id,
        }),
      );
      expect(binding(draftFile(f)).root).toBe(
        `/srv/cardigan-workers/${project}`,
      );
      const next = wizard(await f.post("", form), 201);
      expect(next.preview.diff).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux")(
  "C-846: the owner enables remote launch of an initialized machine from its detail page, which also puts it online",
  async () => {
    const probe = vi.fn<WorkerProbeRunner>(async () => true);
    const f = await fixture(probe);
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const project = f.project.project_id;
      const machinePath = `/machines/${form.machine_id}`;
      const state = async () => {
        const r = await f.call(`${f.base}${machinePath}`);
        expect(r.status, r.text).toBe(200);
        return (r.json as { remote_launch: string }).remote_launch;
      };
      // Not registered yet.
      expect((await f.call(`${f.base}${machinePath}`)).status).toBe(404);
      expect((await f.post(machinePath)).status).toBe(404);
      // Onboarded through a paired draft up to the passed checks, then the
      // session is lost (here: given up).
      const s = wizard(await f.post("", { ...form, layout: "home" }), 201);
      wizard(
        await f.post(`/${s.id}/confirm`, { preview_id: s.preview.preview_id }),
      );
      expect((await f.post(`/${s.id}/run`)).status).toBe(202);
      await vi.waitFor(async () =>
        expect(wizard(await f.call(`${f.base}/${s.id}`)).phase).toBe("passed"),
      );
      expect((await f.post(`/${s.id}/cancel`)).status).toBe(200);
      const registered = () =>
        f.store().uow.read((tx) => tx.machines.get(project, form.machine_id));
      expect(registered()).toMatchObject({ status: "offline" });
      const written = readFileSync(draftFile(f), "utf8");
      expect(await state()).toBe("available");
      // Owner only, human session only, no body.
      const bearer = { authorization: `Bearer ${f.token(f.primary.owner)}` };
      expect(
        (await f.call(`${f.base}${machinePath}`, { headers: bearer })).status,
      ).toBe(403);
      expect(
        (
          await f.call(`${f.base}${machinePath}`, {
            method: "POST",
            body: {},
            headers: bearer,
          })
        ).status,
      ).toBe(403);
      expect(
        (await f.post(machinePath, { allow_remote_launch: true })).status,
      ).toBe(400);
      const started = wizard(await f.post(machinePath), 202);
      expect(started.phase).toBe("running");
      expect(started).not.toHaveProperty("preview");
      const path = `/${started.id}`;
      await vi.waitFor(async () =>
        expect(wizard(await f.call(f.base + path)).phase).toBe("passed"),
      );
      // The draft is continued as written: SteamOS paths stay under /home.
      expect(readFileSync(draftFile(f), "utf8")).toBe(written);
      expect(registered()).toMatchObject({ status: "offline" });
      const launch = wizard(await f.post(`${path}/launch-preview`)).preview;
      expect(launch.diff).toContainEqual({
        field: "allow_remote_launch",
        change: "false → true",
      });
      expect(
        wizard(
          await f.post(`${path}/enable`, {
            preview_id: launch.preview_id,
            allow_remote_launch: true,
          }),
        ).phase,
      ).toBe("enabled");
      expect(registered()).toMatchObject({ status: "online" });
      const [worker] = loadRuntimeWorkers(
        f.dataDir,
        join(f.root, "runtime-workers.yaml"),
      );
      expect(worker).toMatchObject({
        machine_id: form.machine_id,
        allow_remote_launch: true,
      });
      expect(worker?.execution.agentRoot).toBe(
        `/home/cardigan-workers/${project}`,
      );
      expect(await state()).toBe("enabled");
      const again = await f.post(machinePath);
      expect(again.status).toBe(409);
      expect(again.text).toContain("worker_already_enabled");
      const events = f
        .store()
        .uow.read((tx) => tx.global_events.listAfter(0))
        .map((e) => e.type);
      expect(events).toEqual(
        expect.arrayContaining([
          "worker_wizard_machine_resumed",
          "worker_wizard_launch_enabled",
        ]),
      );
    } finally {
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux")(
  "C-846: no detail-page enable without a draft, or with a draft edited by hand",
  async () => {
    const f = await fixture();
    try {
      await f.password(TEST_PASSWORD);
      await f.login();
      const machinePath = `/machines/${form.machine_id}`;
      const s = wizard(await f.post("", form), 201);
      wizard(
        await f.post(`/${s.id}/confirm`, { preview_id: s.preview.preview_id }),
      );
      expect((await f.post(`/${s.id}/run`)).status).toBe(202);
      await vi.waitFor(async () =>
        expect(wizard(await f.call(`${f.base}/${s.id}`)).phase).toBe("passed"),
      );
      const file = draftFile(f);
      const written = readFileSync(file, "utf8");
      writeFileSync(file, `${written}timeout_ms: 4500\n`);
      expect((await f.call(`${f.base}${machinePath}`)).json).toEqual({
        remote_launch: "unavailable",
      });
      const edited = await f.post(machinePath);
      expect(edited.status).toBe(409);
      expect(edited.text).toContain("worker_config_conflict");
      rmSync(file);
      const missingDraft = await f.post(machinePath);
      expect(missingDraft.status).toBe(404);
      expect(missingDraft.text).toContain("worker_draft_missing");
      expect(existsSync(join(f.root, "runtime-workers.yaml"))).toBe(false);
    } finally {
      await f.close();
    }
  },
);
