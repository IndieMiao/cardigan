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
import { Document, stringify } from "yaml";
import { CpuProfileDirectory } from "./cpu-profile-files.js";
import { loadRuntimeWorkers } from "./runtime-workers-config.js";
import { onboardWorker } from "./worker-onboarding.js";
import { workerNextAction } from "./worker-onboarding-probes.js";
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
    // C-595: matching bytes never skip ownership and mode for the agent tools.
    for (const tool of ["download-attachment.mjs", "upload-evidence.mjs"]) {
      expect(d.commands.helpers).toMatch(
        new RegExp(
          `sudo install -o root -g \\S+ -m 0750 /opt/cardigan/deploy/agent-tools/${tool} \\S+/libexec/agent-tools/${tool}`,
          "u",
        ),
      );
      expect(d.commands.helpers).not.toContain(
        `cmp -s /opt/cardigan/deploy/agent-tools/${tool}`,
      );
    }
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
test("C-706: a read-only-root Linux device keeps its work root under /home", () => {
  const d = workerWizardForm("/private/config", data, "example", {
    ...form,
    layout: "home",
  });
  expect(d.config.worker.execution.agentRoot).toBe(
    "/home/cardigan-workers/example",
  );
  expect(d.config.home).toBe("/home/cg_example");
  expect(d.commands.directories).toContain("/home/cardigan-workers/example");
  for (const fields of [
    { layout: "srv" },
    { layout: "/tmp" },
    { layout: "home", os: "macos", arch: "arm64" },
  ])
    expect(() =>
      workerWizardForm("/private/config", data, "example", {
        ...form,
        ...fields,
      }),
    ).toThrow("worker_form_invalid");
});
test.each([
  ["linux", undefined, "/opt/cardigan/deploy"],
  ["macos", undefined, "/opt/cardigan/deploy"],
  ["linux", "home", "/home/cardigan-release/deploy"],
] as const)(
  "C-709: %s layout=%s target commands read the release from %s",
  (os, layout, deploy) => {
    const d = workerWizardForm("/private/config", data, "example", {
      ...form,
      os,
      arch: "arm64",
      ...(layout ? { layout } : {}),
    });
    const other =
      deploy === "/opt/cardigan/deploy"
        ? "/home/cardigan-release"
        : "/opt/cardigan";
    const helpers = workerNextAction("helpers", d.config);
    for (const text of [
      d.commands.directories,
      d.commands.helpers,
      os === "linux" ? d.commands.tools : deploy,
      helpers,
    ]) {
      expect(text).toContain(deploy);
      expect(text).not.toContain(other);
    }
    expect(workerNextAction("directories", d.config)).toBe(
      d.commands.directories,
    );
    // A read-only root cannot take a global npm install.
    const tools = workerNextAction("tools", d.config);
    if (layout) {
      expect(tools).toContain("docs/steamos-worker.md");
      expect(tools).not.toContain("npm install --global");
    } else if (os === "linux") expect(tools).toContain("npm install --global");
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
    // Even valid serialized output must be refused if an unrelated binding changed.
    const originalToString = Document.prototype.toString;
    const serialization = vi
      .spyOn(Document.prototype, "toString")
      .mockImplementationOnce(function (this: Document, opts) {
        this.setIn(["machines", 0, "projects", 0, "session"], "other-session");
        return originalToString.call(this, opts);
      });
    try {
      expect(() => planWorkerFile(root, data, d.raw, d.config, true)).toThrow(
        "worker_config_conflict",
      );
    } finally {
      serialization.mockRestore();
    }
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

test.runIf(process.platform === "linux")(
  "identity and draft reservations are checked both before preview and under the onboarding lock before writing",
  async () => {
    const d = setup();
    const file = join(root, "worker-worker-a-example.yaml");
    const original = stringify(d.raw);
    writeFileSync(file, original, { mode: 0o600 });
    const moved = workerWizardForm(root, data, "example", {
      ...form,
      host: "moved.invalid",
    });
    // The operator previews before a concurrent CLI add has claimed the machine.
    const plan = () => planWorkerFile(root, data, moved.raw, moved.config),
      p = plan();
    const peer = workerWizardForm(root, data, "peer", form);
    expect(
      await onboardWorker({
        config: peer.config,
        configRoot: root,
        dataDir: data,
        mode: "add",
        registration: async () => true,
        probe: async () => true,
        report: () => {},
      }),
    ).toBe(true);
    expect(() => commitWorkerFile(root, p)).toThrow("worker_config_conflict");
    expect(plan).toThrow("worker_config_conflict");
    // Even with unchanged machine identity the peer's project draft reserves its account and group.
    expect(() => planWorkerFile(root, data, d.raw, d.config)).toThrow(
      "worker_config_conflict",
    );
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readdirSync(root).filter((f) => f.endsWith(".bak"))).toEqual([]);
  },
);

test.runIf(process.platform === "linux")(
  "refuses an anchored launch field without rewriting the runtime file",
  () => {
    const d = setup();
    commitWorkerFile(root, planWorkerFile(root, data, d.raw, d.config));
    const m = d.raw.runtime.machines[0];
    if (!m) throw Error("missing fixture");
    const live = {
      version: 1,
      machines: [
        {
          ...m,
          projects: m.projects.map((p) => ({
            ...p,
            allow_remote_launch: false,
          })),
        },
      ],
    };
    const path = join(root, "runtime-workers.yaml");
    const text = stringify(live).replace(
      "allow_remote_launch: false",
      "allow_remote_launch: &gate false",
    );
    writeFileSync(path, text, { mode: 0o600 });
    expect(() => planWorkerFile(root, data, d.raw, d.config, true)).toThrow(
      "worker_shared_yaml",
    );
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(loadRuntimeWorkers(data, path)[0]?.allow_remote_launch).toBe(false);
  },
);
