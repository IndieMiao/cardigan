import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";
import {
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

async function fixture(env: NodeJS.ProcessEnv = { CARDIGAN_MCP_URL: MCP }) {
  const root = mkdtempSync(join(tmpdir(), "pairing-"));
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
        { device: { ...device, token: "x" } },
        { device, extra: true },
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
      const waiting = run([f.web.url], { PATH });
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
