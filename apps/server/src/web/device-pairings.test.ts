import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRunLimit } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";
import {
  PAIRING_INIT_WINDOW_MS,
  PAIRING_MAX_PENDING,
  PAIRING_RETENTION_MS,
  PAIRING_TTL_MS,
} from "./device-pairings.js";

const device = {
  hostname: "steamdeck",
  os: "linux",
  arch: "x64",
  address: "steamdeck.example.ts.net",
  free_id: 2000,
  system: "SteamOS 3.8",
};
const MCP = "https://private.example.ts.net/mcp";
const SCRIPT = resolve(__dirname, "../../../web/public/pair-device.py");
const KEY_BLOB = Buffer.concat([
  Buffer.from("\0\0\0\x0bssh-ed25519\0\0\0\x20", "latin1"),
  Buffer.alloc(32, 9),
]).toString("base64");

async function fixture(env: NodeJS.ProcessEnv = { CARDIGAN_MCP_URL: MCP }) {
  const root = mkdtempSync(join(tmpdir(), "pairing-"));
  writeFileSync(
    join(root, "worker-key.pub"),
    `ssh-ed25519 ${KEY_BLOB} operator@control\n`,
  );
  const f = await m5Cross({
    machineHost: {
      bindings: () => () => null,
      workerRecord: () => null,
      check: async () => {
        throw new Error("unexpected");
      },
      wizard: {
        root,
        dataDir: "/private/controller",
        env,
        probe: async () => true,
        refresh: vi.fn(async () => {}),
      },
    },
  });
  await f.password(TEST_PASSWORD);
  await f.login();
  const pair = (body: unknown = { device }) =>
    f.call("/api/device-pairings", { method: "POST", body, anonymous: true });
  const status = (device_token: unknown) =>
    f.call("/api/device-pairings/status", {
      method: "POST",
      body: { device_token },
      anonymous: true,
    });
  const claim = (code: unknown, extra: Record<string, unknown> = {}) =>
    f.call(f.projectPath("/worker-wizards/pairing"), {
      method: "POST",
      body: { code, ...extra },
    });
  const device$ = (path: string, body: unknown) =>
    f.call(`/api/device-pairings/${path}`, {
      method: "POST",
      body,
      anonymous: true,
    });
  const created = async () => {
    const r = await pair();
    expect(r.status, r.text).toBe(201);
    return r.json as {
      code: string;
      device_token: string;
      expires_at: string;
      confirm_url: string;
      qr: string[] | null;
    };
  };
  return {
    ...f,
    root,
    pair,
    status,
    claim,
    created,
    device$,
    close: async () => {
      try {
        await f.close();
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  };
}
const errorCode = (r: { json: unknown }) =>
  (r.json as { error: { code: string } }).error.code;
const secretsAbsent = (
  f: Awaited<ReturnType<typeof fixture>>,
  secrets: string[],
) => {
  const events = JSON.stringify(
    f.store().database.prepare("SELECT doc FROM global_events").all(),
  );
  const timeline = JSON.stringify(
    f.store().database.prepare("SELECT * FROM events").all(),
  );
  const logs = JSON.stringify(f.logs);
  for (const secret of secrets)
    for (const text of [events, timeline, logs])
      expect(text.includes(secret)).toBe(false);
};

test.runIf(process.platform === "linux")(
  "a device gets a one-time code; the owner's code becomes a wizard preview draft once",
  async () => {
    const f = await fixture();
    try {
      const p = await f.created();
      expect(p.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/u);
      expect(p.confirm_url).toBe(`${f.web.url}/#/pair/${p.code}`);
      expect(p.qr?.length).toBeGreaterThan(10);
      expect(Date.parse(p.expires_at) - f.now()).toBe(PAIRING_TTL_MS);
      expect((await f.status(p.device_token)).json).toMatchObject({
        status: "pending",
      });

      // Only a signed-in human owner may use a code.
      const anonymous = await f.call(f.projectPath("/worker-wizards/pairing"), {
        method: "POST",
        body: { code: p.code },
        anonymous: true,
      });
      expect(anonymous.status).toBe(401);
      const bearer = await f.call(f.projectPath("/worker-wizards/pairing"), {
        method: "POST",
        body: { code: p.code },
        headers: { authorization: `Bearer ${f.token(f.primary.owner)}` },
      });
      expect(bearer.status).toBe(403);
      expect(
        (await f.claim(p.code, { allow_remote_launch: true })).status,
      ).toBe(400);

      // Lower case and without the dash is the same code.
      const r = await f.claim(p.code.toLowerCase().replace("-", " "));
      expect(r.status, r.text).toBe(201);
      const body = r.json as {
        wizard: {
          id: string;
          phase: string;
          machine_id: string;
          os: string;
          preview: { preview_id: string };
          commands: Record<string, string>;
        };
        device: typeof device;
      };
      // Only a draft in the existing wizard: preview first, nothing written,
      // remote launch still off until its own step.
      expect(body.wizard).toMatchObject({
        phase: "preview",
        machine_id: "steamdeck",
        os: "linux",
      });
      expect(body.wizard.commands.account).toContain("--uid 2000");
      expect(body.device).toEqual(device);
      const read = await f.call(
        f.projectPath(`/worker-wizards/${body.wizard.id}`),
      );
      expect((read.json as { wizard: { phase: string } }).wizard.phase).toBe(
        "preview",
      );
      expect((await f.status(p.device_token)).json).toMatchObject({
        status: "claimed",
      });

      // Replay: a used code never opens a second draft.
      const again = await f.claim(p.code);
      expect(again.status).toBe(409);
      expect(errorCode(again)).toBe("pairing_code_used");

      secretsAbsent(f, [p.code, p.code.replace("-", ""), p.device_token]);
      const audit = JSON.stringify(
        f.store().database.prepare("SELECT doc FROM global_events").all(),
      );
      expect(audit).toContain("worker_wizard_pairing_claimed");
      expect(audit).toContain("worker_wizard_previewed");
    } finally {
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux")(
  "expired, unknown and malformed codes have distinct errors; wrong guesses lock out",
  async () => {
    const f = await fixture();
    try {
      const p = await f.created();
      f.advance(PAIRING_TTL_MS);
      const expired = await f.claim(p.code);
      expect(expired.status).toBe(410);
      expect(errorCode(expired)).toBe("pairing_code_expired");
      expect((await f.status(p.device_token)).json).toMatchObject({
        status: "expired",
      });
      f.advance(PAIRING_RETENTION_MS);
      const forgotten = await f.claim(p.code);
      expect(forgotten.status).toBe(404);
      expect(errorCode(forgotten)).toBe("pairing_code_invalid");
      expect((await f.status(p.device_token)).status).toBe(404);
      expect((await f.status("x".repeat(500))).status).toBe(404);

      for (const code of ["", "ABC", "IIII-OOOO", 12345678])
        expect(errorCode(await f.claim(code))).toBe("pairing_code_invalid");
      // Five wrong codes in a row lock the member out, even for a real code.
      const real = await f.created();
      const locked = await f.claim(real.code);
      expect(locked.status).toBe(429);
      expect(errorCode(locked)).toBe("pairing_rate_limited");
      expect(locked.headers["retry-after"]).toBeDefined();
      f.advance(31_000);
      expect((await f.claim(real.code)).status).toBe(201);
    } finally {
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux")(
  "concurrent claims of one code: exactly one draft; concurrent devices get distinct codes",
  async () => {
    const f = await fixture();
    try {
      const devices = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          f.pair({ device: { ...device, hostname: `deck-${i}` } }),
        ),
      );
      const codes = devices.map((r) => (r.json as { code: string }).code);
      expect(new Set(codes).size).toBe(4);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => f.claim(codes[0])),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        201, 409, 409, 409, 409,
      ]);
      expect(results.filter((r) => r.status === 409).map(errorCode)).toEqual(
        Array(4).fill("pairing_code_used"),
      );
      // Different codes for different machines are independent.
      const other = await Promise.all([f.claim(codes[1]), f.claim(codes[2])]);
      expect(other.map((r) => r.status)).toEqual([201, 201]);
    } finally {
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux")(
  "device input is validated, origin-checked and pending pairings are capped",
  async () => {
    const f = await fixture();
    try {
      for (const bad of [
        {},
        { device: { ...device, os: "windows" } },
        { device: { ...device, arch: "riscv64" } },
        { device: { ...device, hostname: "-x" } },
        { device: { ...device, address: "a b" } },
        { device: { ...device, free_id: 0 } },
        { device: { ...device, system: "a\nb" } },
        { device: { ...device, root_readonly: "yes" } },
        { device: { ...device, token: "x" } },
        { device, extra: true },
        // C-707: hardware facts are optional, but well formed when sent.
        { device: { ...device, cpu: "a\u0007b" } },
        { device: { ...device, cpu: "x".repeat(121) } },
        { device: { ...device, cpu_cores: 0 } },
        { device: { ...device, memory_bytes: 1.5 } },
        { device: { ...device, gpu: " " } },
        { device: { ...device, disk_total_bytes: 10, disk_free_bytes: 1 } },
        {
          device: {
            ...device,
            disk_path: "/tmp",
            disk_total_bytes: 10,
            disk_free_bytes: 1,
          },
        },
        {
          device: {
            ...device,
            disk_path: "/",
            disk_total_bytes: 10,
            disk_free_bytes: 11,
          },
        },
      ]) {
        const r = await f.pair(bad);
        expect(r.status, JSON.stringify(bad)).toBe(400);
      }
      const foreign = await f.call("/api/device-pairings", {
        method: "POST",
        body: { device },
        anonymous: true,
        headers: { origin: "https://untrusted.invalid" },
      });
      expect(foreign.status).toBe(403);
      expect(
        (await f.call("/api/device-pairings", { anonymous: true })).status,
      ).toBe(405);
      for (let i = 0; i < PAIRING_MAX_PENDING; i++) await f.created();
      const full = await f.pair();
      expect(full.status).toBe(429);
      expect(errorCode(full)).toBe("pairing_capacity");
      f.advance(PAIRING_TTL_MS);
      await f.created();
    } finally {
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux")(
  "a draft the host cannot build keeps the code usable and returns the device facts",
  async () => {
    const f = await fixture({});
    try {
      const p = await f.created();
      const r = await f.claim(p.code);
      // Same status and code as the wizard form with no MCP address.
      expect(r.status, r.text).toBe(409);
      expect(errorCode(r)).toBe("worker_mcp_url_invalid");
      expect(
        (r.json as { error: { details: { form: unknown } } }).error.details
          .form,
      ).toMatchObject({
        machine_id: "steamdeck",
        uid: 2000,
        host: device.address,
      });
      expect((await f.status(p.device_token)).json).toMatchObject({
        status: "pending",
      });
      const list = await f.call(f.projectPath("/worker-wizards/defaults"));
      expect(list.status).toBe(200);
    } finally {
      await f.close();
    }
  },
);

interface WizardView {
  id: string;
  phase: string;
  preview?: { preview_id: string };
  device_init?: { state: string; at?: string };
}
const planOf = (script: string) =>
  JSON.parse(
    Buffer.from(
      /^PLAN = json\.loads\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/mu.exec(
        script,
      )?.[1] ?? "",
      "base64",
    ).toString(),
  ) as Record<string, unknown>;
async function claimAndConfirm(f: Awaited<ReturnType<typeof fixture>>) {
  const p = await f.created();
  const claimed = await f.claim(p.code);
  expect(claimed.status, claimed.text).toBe(201);
  const w = (claimed.json as { wizard: WizardView }).wizard;
  const path = f.projectPath(`/worker-wizards/${w.id}`);
  const read = async () =>
    ((await f.call(path)).json as { wizard: WizardView }).wizard;
  const confirm = () =>
    f.call(`${path}/confirm`, {
      method: "POST",
      body: { preview_id: w.preview?.preview_id },
    });
  return { p, w, path, read, confirm };
}

test.runIf(process.platform === "linux")(
  "a confirmed draft gives the claimed device its init script; the report is recorded and starts the recheck",
  async () => {
    const f = await fixture();
    try {
      const early = await f.created();
      const before = await f.device$("init-script", {
        device_token: early.device_token,
      });
      expect(before.status).toBe(409);
      expect(errorCode(before)).toBe("device_init_not_ready");

      const { p, w, read, confirm } = await claimAndConfirm(f);
      const token = { device_token: p.device_token };
      expect(w.device_init).toEqual({ state: "waiting" });
      expect((await f.status(p.device_token)).json).toMatchObject({
        status: "claimed",
        init: "waiting",
      });
      // Nothing before the owner confirmed the configuration.
      const unconfirmed = await f.device$("init-script", token);
      expect(unconfirmed.status).toBe(409);
      expect(errorCode(unconfirmed)).toBe("device_init_not_ready");
      expect(
        errorCode(await f.device$("initialized", { ...token, ok: true })),
      ).toBe("device_init_not_ready");

      expect((await confirm()).status).toBe(200);
      expect((await f.status(p.device_token)).json).toMatchObject({
        init: "ready",
      });
      const got = await f.device$("init-script", token);
      expect(got.status, got.text).toBe(200);
      expect(got.headers["cache-control"]).toBe("no-store");
      const script = (got.json as { script: string }).script;
      const project = f.project.project_id;
      const account =
        `cg_${project.toLowerCase().replace(/[^a-z0-9_]/gu, "_")}`.slice(0, 29);
      // SteamOS: the work root is under /home; only fixed, non-secret values.
      expect(planOf(script)).toEqual({
        version: 1,
        os: "linux",
        project,
        account,
        uid: 2000,
        gid: 2000,
        home: `/home/${account}`,
        work: `/home/cardigan-workers/${project}`,
        public_key: `restrict ssh-ed25519 ${KEY_BLOB}`,
      });
      for (const secret of [
        p.device_token,
        p.code,
        p.code.replace("-", ""),
        "operator@control",
        MCP,
        f.root,
      ])
        expect(script.includes(secret)).toBe(false);
      expect((await read()).device_init).toEqual({ state: "fetched" });

      for (const bad of [
        { ...token, ok: "yes" },
        { ...token },
        { ...token, ok: true, extra: 1 },
      ])
        expect((await f.device$("initialized", bad)).status).toBe(400);
      expect(
        (await f.device$("initialized", { device_token: "x", ok: true }))
          .status,
      ).toBe(404);

      const report = await f.device$("initialized", { ...token, ok: true });
      expect(report.status, report.text).toBe(200);
      expect(report.json).toEqual({ recheck: "started" });
      const after = await read();
      expect(after.device_init).toEqual({
        state: "succeeded",
        at: expect.any(String),
      });
      expect(after.phase).not.toBe("ready");
      await vi.waitFor(async () =>
        expect((await read()).phase).not.toBe("running"),
      );
      expect((await f.status(p.device_token)).json).toMatchObject({
        init: "succeeded",
      });
      for (const again of [
        await f.device$("init-script", token),
        await f.device$("initialized", { ...token, ok: true }),
      ]) {
        expect(again.status).toBe(409);
        expect(errorCode(again)).toBe("device_init_reported");
      }
      const audit = JSON.stringify(
        f.store().database.prepare("SELECT doc FROM global_events").all(),
      );
      expect(audit).toContain("worker_wizard_device_initialized");
      expect(audit).toContain("worker_wizard_check_requested");
      secretsAbsent(f, [p.code, p.code.replace("-", ""), p.device_token]);

      f.advance(PAIRING_INIT_WINDOW_MS);
      expect((await f.status(p.device_token)).status).toBe(404);
    } finally {
      await f.close();
    }
  },
);

test.runIf(process.platform === "linux")(
  "a failed run starts no recheck and may be retried; a missing host key or cancelled draft is refused",
  async () => {
    const f = await fixture();
    try {
      const { p, path, read, confirm } = await claimAndConfirm(f);
      const token = { device_token: p.device_token };
      expect((await confirm()).status).toBe(200);
      rmSync(join(f.root, "worker-key.pub"));
      const missing = await f.device$("init-script", token);
      expect(missing.status).toBe(409);
      expect(errorCode(missing)).toBe("device_init_public_key_missing");
      writeFileSync(
        join(f.root, "worker-key.pub"),
        `ssh-ed25519 ${KEY_BLOB}\n`,
      );
      expect((await f.device$("init-script", token)).status).toBe(200);
      const failed = await f.device$("initialized", { ...token, ok: false });
      expect(failed.json).toEqual({ recheck: "skipped" });
      expect(await read()).toMatchObject({
        phase: "ready",
        device_init: { state: "failed" },
      });
      expect((await f.device$("init-script", token)).status).toBe(200);
      expect(
        (await f.device$("initialized", { ...token, ok: true })).json,
      ).toEqual({ recheck: "started" });
      await vi.waitFor(async () =>
        expect((await read()).phase).not.toBe("running"),
      );

      const second = await claimAndConfirm(f);
      expect((await second.confirm()).status).toBe(200);
      expect(
        (await f.call(`${second.path}/cancel`, { method: "POST", body: {} }))
          .status,
      ).toBe(200);
      expect((await f.status(second.p.device_token)).json).toMatchObject({
        init: "unavailable",
      });
      const gone = await f.device$("init-script", {
        device_token: second.p.device_token,
      });
      expect(gone.status).toBe(410);
      expect(errorCode(gone)).toBe("device_init_unavailable");
      expect(path).not.toBe(second.path);
    } finally {
      await f.close();
    }
  },
);

const hardware = {
  cpu: "AMD Custom APU 0405",
  cpu_cores: 8,
  memory_bytes: 16 * 1024 ** 3,
  disk_path: "/home",
  disk_total_bytes: 512 * 1024 ** 3,
  disk_free_bytes: 400 * 1024 ** 3,
  gpu: "AMD Custom GPU 0405",
};
interface ReportView extends WizardView {
  device?: Record<string, unknown>;
  run_limit?: { value: number; state: string };
  report?: {
    capabilities: { key: string; state: string }[];
    suggested: string[];
  };
}
test.runIf(process.platform === "linux")(
  "C-707: the chosen Agent limit is set when a new machine registers; the report comes with the passed wizard",
  async () => {
    const f = await fixture();
    try {
      const r = await f.pair({ device: { ...device, ...hardware } });
      expect(r.status, r.text).toBe(201);
      const { code } = r.json as { code: string };
      const path = (id: string) => f.projectPath(`/worker-wizards/${id}`);
      const read = async (id: string) =>
        ((await f.call(path(id))).json as { wizard: ReportView }).wizard;

      // A bad limit is refused before the code is used.
      for (const run_limit of [0, -1, 1.5, "2", null]) {
        const bad = await f.claim(code, { run_limit });
        expect(bad.status, JSON.stringify(run_limit)).toBe(400);
        expect(errorCode(bad)).toBe("worker_run_limit_invalid");
      }
      const tooMany = await f.claim(code, { run_limit: 17 });
      expect(tooMany.status).toBe(400);
      expect(
        (tooMany.json as { error: { details: unknown } }).error.details,
      ).toEqual({ maximum: 16 });
      const bearer = await f.call(f.projectPath("/worker-wizards/pairing"), {
        method: "POST",
        body: { code, run_limit: 1 },
        headers: { authorization: `Bearer ${f.token(f.primary.owner)}` },
      });
      expect(bearer.status).toBe(403);

      const claimed = await f.claim(code, { run_limit: 2 });
      expect(claimed.status, claimed.text).toBe(201);
      const w = (claimed.json as { wizard: ReportView & WizardView }).wizard;
      expect(w.device).toEqual({ ...device, ...hardware });
      expect(w.run_limit).toEqual({ value: 2, state: "pending" });
      expect(w.report).toBeUndefined();
      // Nothing is set before the machine registers.
      expect(readRunLimit(f.store().database, "steamdeck")).toBeUndefined();
      expect(
        (
          await f.call(`${path(w.id)}/confirm`, {
            method: "POST",
            body: { preview_id: w.preview?.preview_id },
          })
        ).status,
      ).toBe(200);
      expect(
        (await f.call(`${path(w.id)}/run`, { method: "POST", body: {} }))
          .status,
      ).toBe(202);
      await vi.waitFor(async () =>
        expect((await read(w.id)).phase).toBe("passed"),
      );
      const passed = await read(w.id);
      expect(passed.run_limit).toEqual({ value: 2, state: "applied" });
      expect(readRunLimit(f.store().database, "steamdeck")).toMatchObject({
        machine_id: "steamdeck",
        limit: 2,
      });
      // Host facts only: catalog tools for Linux not verified yet.
      expect(passed.report?.suggested).toEqual(
        expect.arrayContaining(["node", "godot", "blender"]),
      );
      expect(passed.report?.suggested).not.toContain("xcode");
      expect(passed.report?.capabilities).toContainEqual(
        expect.objectContaining({ key: "node", state: "unverified" }),
      );
      // Owner-only like the rest of the wizard.
      const other = await f.call(path(w.id), {
        headers: { authorization: `Bearer ${f.token(f.primary.owner)}` },
      });
      expect(other.status).toBe(403);
      expect(other.text).not.toContain("AMD Custom");

      // Pairing a machine this host already has never changes its limit.
      const again = await f.pair({ device: { ...device, ...hardware } });
      const second = await f.claim((again.json as { code: string }).code, {
        run_limit: 5,
      });
      expect(second.status, second.text).toBe(201);
      const s2 = (second.json as { wizard: ReportView & WizardView }).wizard;
      await f.call(`${path(s2.id)}/confirm`, {
        method: "POST",
        body: { preview_id: s2.preview?.preview_id },
      });
      await f.call(`${path(s2.id)}/run`, { method: "POST", body: {} });
      await vi.waitFor(async () =>
        expect((await read(s2.id)).phase).toBe("passed"),
      );
      expect((await read(s2.id)).run_limit).toEqual({
        value: 5,
        state: "kept",
      });
      expect(readRunLimit(f.store().database, "steamdeck")).toMatchObject({
        limit: 2,
      });
    } finally {
      await f.close();
    }
  },
);

function run(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn("python3", ["-I", SCRIPT, ...args], {
    env: { PATH: env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const done = new Promise<number | null>((ok) => child.on("close", ok));
  return { child, done, out: () => stdout, err: () => stderr };
}

test.runIf(process.platform === "linux")(
  "the device script reads tailscale, shows code and QR, and exits once confirmed",
  async () => {
    const f = await fixture();
    const bin = mkdtempSync(join(tmpdir(), "pairing-bin-"));
    try {
      const tailscale = (state: string) => {
        writeFileSync(
          join(bin, "tailscale"),
          `#!/bin/sh\necho '${JSON.stringify({ BackendState: state, Self: { DNSName: "deck.example.ts.net.", TailscaleIPs: ["100.64.0.9"] } })}'\n`,
        );
        chmodSync(join(bin, "tailscale"), 0o755);
      };
      const PATH = `${bin}:/usr/bin:/bin`;
      tailscale("NeedsLogin");
      const offline = run([f.web.url], { PATH });
      expect(await offline.done).toBe(2);
      expect(offline.err()).toContain("tailscale up");

      tailscale("Running");
      const waiting = run([f.web.url, "--no-init"], { PATH });
      await vi.waitFor(() => expect(waiting.out()).toContain("等待"), {
        timeout: 10_000,
      });
      const code = /配对码：(\S+)/u.exec(waiting.out())?.[1] ?? "";
      expect(waiting.out()).toContain("█");
      expect(waiting.out()).toContain("deck.example.ts.net");
      expect(waiting.out()).not.toContain("device_token");
      const claimed = await f.claim(code);
      expect(claimed.status, claimed.text).toBe(201);
      expect(
        (claimed.json as { device: { address: string } }).device.address,
      ).toBe("deck.example.ts.net");
      expect(await waiting.done).toBe(0);
      expect(waiting.out()).toContain("已在 Workbench 确认");

      const quick = run(
        [f.web.url, "--no-wait", "--light", "--address", "100.64.0.9"],
        {
          PATH: "/usr/bin:/bin",
        },
      );
      expect(await quick.done).toBe(0);
      expect(quick.out()).toContain("100.64.0.9");
      const bad = run(["https://host.invalid/path"], { PATH });
      expect(await bad.done).toBe(2);
    } finally {
      rmSync(bin, { force: true, recursive: true });
      await f.close();
    }
  },
  30_000,
);

test.runIf(process.platform === "linux")(
  "after the owner confirms, the device lists the script's actions, runs it with sudo from stdin and reports",
  async () => {
    const f = await fixture();
    const bin = mkdtempSync(join(tmpdir(), "pairing-bin-"));
    try {
      writeFileSync(
        join(bin, "tailscale"),
        `#!/bin/sh\necho '${JSON.stringify({ BackendState: "Running", Self: { DNSName: "deck.example.ts.net." } })}'\n`,
      );
      const sudo = (code: number) => {
        writeFileSync(
          join(bin, "sudo"),
          `#!/bin/sh\necho "$@" > '${bin}/argv'\ncat > '${bin}/stdin'\nexit ${code}\n`,
        );
        chmodSync(join(bin, "sudo"), 0o755);
      };
      chmodSync(join(bin, "tailscale"), 0o755);
      const PATH = `${bin}:/usr/bin:/bin`;
      const device = async (code: number) => {
        sudo(code);
        const args = [f.web.url, "--yes", "--sudo", join(bin, "sudo")];
        const proc = run([...args, "--python", "python3"], { PATH });
        await vi.waitFor(() => expect(proc.out()).toContain("等待"), {
          timeout: 10_000,
        });
        const pairCode = /配对码：(\S+)/u.exec(proc.out())?.[1] ?? "";
        const claimed = await f.claim(pairCode);
        expect(claimed.status, claimed.text).toBe(201);
        const w = (claimed.json as { wizard: WizardView }).wizard;
        await vi.waitFor(() => expect(proc.out()).toContain("确认写入配置"), {
          timeout: 10_000,
        });
        const path = f.projectPath(`/worker-wizards/${w.id}`);
        const confirmed = await f.call(`${path}/confirm`, {
          method: "POST",
          body: { preview_id: w.preview?.preview_id },
        });
        expect(confirmed.status).toBe(200);
        const exit = await proc.done;
        const wizard = ((await f.call(path)).json as { wizard: WizardView })
          .wizard;
        return { proc, exit, wizard };
      };

      const ok = await device(0);
      expect(ok.exit, ok.proc.err()).toBe(0);
      expect(ok.proc.out()).toContain("初始化脚本将在本机做以下操作");
      expect(ok.proc.out()).toMatch(/1\. 创建组 cg_/u);
      expect(ok.proc.out()).toContain("初始化完成，已通知 Workbench 开始复查");
      expect(readFileSync(join(bin, "argv"), "utf8").trim()).toBe(
        "python3 -IB -",
      );
      const piped = readFileSync(join(bin, "stdin"), "utf8");
      expect(piped).toContain('"""Cardigan one-time device initialisation');
      expect(planOf(piped).public_key).toBe(`restrict ssh-ed25519 ${KEY_BLOB}`);
      expect(ok.wizard.device_init?.state).toBe("succeeded");
      await vi.waitFor(async () =>
        expect(
          (
            (await f.call(f.projectPath(`/worker-wizards/${ok.wizard.id}`)))
              .json as { wizard: WizardView }
          ).wizard.phase,
        ).not.toBe("running"),
      );

      const bad = await device(3);
      expect(bad.exit).toBe(1);
      expect(bad.proc.err()).toContain("初始化未完成（退出码 3）");
      expect(bad.wizard.device_init?.state).toBe("failed");
    } finally {
      rmSync(bin, { force: true, recursive: true });
      await f.close();
    }
  },
  60_000,
);

test("the pairing script is served as a static file", async () => {
  const f = await m5Cross();
  try {
    writeFileSync(join(f.staticDir, "pair-device.py"), "print('x')\n");
    const r = await f.call("/pair-device.py", { anonymous: true });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/x-python; charset=utf-8");
  } finally {
    await f.close();
  }
});
