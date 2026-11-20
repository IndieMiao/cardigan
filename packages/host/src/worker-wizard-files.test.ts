import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { CpuProfileDirectory } from "./cpu-profile-files.js";
import { loadRuntimeWorkers } from "./runtime-workers-config.js";
import { commitWorkerFile, planWorkerFile } from "./worker-wizard-files.js";
import { workerWizardForm } from "./worker-wizard-form.js";

const form = {
  machine_id: "worker-a",
  label: "Test",
  os: "linux",
  arch: "x64",
  host: "private.invalid",
  account: "cg_example",
  uid: 2201,
  gid: 2201,
  mcp_url: "https://private.example.ts.net/mcp",
};
const data = "/private/controller";
let root = "";
afterEach(() => {
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});
function setup() {
  root = mkdtempSync(join(tmpdir(), "worker-config-"));
  return workerWizardForm(root, data, "example", form);
}
test.each(["linux", "macos"])(
  "builds parser-validated %s commands without free-form executable or SSH fields",
  (os) => {
    const d = workerWizardForm("/private/config", data, "example", {
      ...form,
      os,
      arch: "arm64",
      label: "free-form text",
    });
    expect(d.config.worker.allow_remote_launch).toBe(false);
    expect(d.config.worker.os).toBe(os === "macos" ? "darwin" : os);
    expect(d.commands.account).toContain(os === "macos" ? "dscl" : "useradd");
    expect(d.commands.directories).toContain(`install-${os}-worker.py`);
    expect(d.commands.helpers).toContain("worker-files.py");
    expect(d.commands.tools).toContain(os === "macos" ? "codesign" : "payload");
    expect(JSON.stringify(d.commands)).not.toMatch(
      /private\.invalid|private\.example|worker-key|worker-known-hosts|free-form text|ssh |token/i,
    );
    for (const fields of [
      { command: "ignored" },
      { identity_file: "/override" },
      { account: "other;unexpected" },
      { host: "bad host" },
      { uid: 0 },
      { machine_id: "../sibling" },
      { mcp_url: `${form.mcp_url}?token=hidden` },
    ])
      expect(() =>
        workerWizardForm("/private/config", data, "example", {
          ...form,
          ...fields,
        }),
      ).toThrow();
  },
);
test.runIf(process.platform === "linux")(
  "private CAS: changed source, unsafe mode/link or staging failure leaves exact original; successful replace keeps private backup",
  () => {
    const d = setup();
    const path = join(root, "worker-worker-a-example.yaml");
    const original = `# private note\n${stringify({ ...d.raw, timeout_ms: 3500 })}`;
    writeFileSync(path, original, { mode: 0o600 });
    const plan = () => planWorkerFile(root, data, d.raw, d.config);
    const p = plan();
    expect(p.diff).toContainEqual({
      field: "timeout_ms",
      change: "remove",
      before: 3500,
    });
    writeFileSync(path, `${original}\n`);
    expect(() => commitWorkerFile(root, p)).toThrow("worker_preview_stale");
    expect(readFileSync(path, "utf8")).toBe(`${original}\n`);
    chmodSync(path, 0o644);
    expect(plan).toThrow();
    chmodSync(path, 0o600);
    const current = plan();
    const other = join(root, "replacement");
    writeFileSync(other, original, { mode: 0o600 });
    unlinkSync(path);
    symlinkSync(other, path);
    expect(() => commitWorkerFile(root, current)).toThrow();
    expect(readFileSync(other, "utf8")).toBe(original);
    unlinkSync(path);
    writeFileSync(path, original, { mode: 0o600 });
    const originalPublish = CpuProfileDirectory.prototype.publish;
    const fail = vi
      .spyOn(CpuProfileDirectory.prototype, "publish")
      .mockImplementation(function (
        this: CpuProfileDirectory,
        name,
        bytes,
        replace,
      ) {
        if (name.startsWith("stage-")) throw Error("disk full");
        return originalPublish.call(this, name, bytes, replace);
      });
    expect(() => commitWorkerFile(root, p)).toThrow("disk full");
    expect(readFileSync(path, "utf8")).toBe(original);
    fail.mockRestore();
    expect(() =>
      commitWorkerFile(root, p, (apply) => {
        apply();
        throw Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(readFileSync(path, "utf8")).toBe(original);
    commitWorkerFile(root, p);
    const backups = readdirSync(root).filter((n) => n.endsWith(".bak"));
    expect(backups.length).toBeGreaterThan(0);
    for (const b of backups) {
      expect(readFileSync(join(root, b), "utf8")).toBe(original);
      expect(statSync(join(root, b)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path)).toEqual(p.bytes);
  },
);
test.runIf(process.platform === "linux")(
  "enabling adds just the checked binding to an existing physical machine, preserving enabled peers",
  () => {
    const d = setup();
    const other = workerWizardForm(root, data, "peer", {
      ...form,
      account: "cg_peer",
      uid: 2202,
      gid: 2202,
    });
    const m = other.raw.runtime.machines[0];
    if (!m) throw Error("missing fixture");
    const live = {
      version: 1,
      machines: [
        {
          ...m,
          projects: m.projects.map((p) => ({
            ...p,
            allow_remote_launch: true,
          })),
        },
      ],
    };
    const path = join(root, "runtime-workers.yaml");
    writeFileSync(path, `# keep\n${stringify(live)}`, { mode: 0o600 });
    const before = loadRuntimeWorkers(data, path);
    commitWorkerFile(root, planWorkerFile(root, data, d.raw, d.config));
    expect(loadRuntimeWorkers(data, path)).toEqual(before);
    const p = planWorkerFile(root, data, d.raw, d.config, true);
    commitWorkerFile(root, p);
    const after = loadRuntimeWorkers(data, path);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({
      project_id: "example",
      allow_remote_launch: true,
    });
    expect(readFileSync(path, "utf8")).toContain("# keep");
    expect(() => planWorkerFile(root, data, d.raw, d.config)).toThrow(
      "worker_already_enabled",
    );
  },
);
