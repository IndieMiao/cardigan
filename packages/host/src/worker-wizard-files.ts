import { createHash, randomUUID } from "node:crypto";
import { fsyncSync, linkSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isScalar, parse, parseDocument, stringify } from "yaml";
import { CpuProfileDirectory } from "./cpu-profile-files.js";
import {
  parseRuntimeWorkers,
  type RuntimeWorker,
} from "./runtime-workers-config.js";
import { withWorkerBindingCheck } from "./worker-onboarding.js";
import {
  checkWorkerDraft,
  onboardingFail,
  parseWorkerOnboarding,
  readWorkerPrivateFile,
  type WorkerOnboardingConfig,
} from "./worker-onboarding-config.js";

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function snapshot(root: string, name: string) {
  const bytes = readWorkerPrivateFile(join(root, name));
  return {
    bytes,
    revision: bytes ? hash(bytes) : null,
    parsed: bytes ? parse(bytes.toString("utf8")) : undefined,
  };
}
export interface WizardFilePlan {
  binding: {
    config: WorkerOnboardingConfig;
    dataDir: string;
    priorDigest: string | undefined;
  };
  name: string;
  revision: string | null;
  bytes: Buffer;
  guardName: string;
  guardRevision: string | null;
  diff: {
    field: string;
    change: string;
    before?: string | number | boolean;
    after?: string | number | boolean;
  }[];
}
// Never return SSH endpoints, paths, account names or URLs from private YAML.
function differences(
  before: unknown,
  after: unknown,
  field = "",
): WizardFilePlan["diff"] {
  const obj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object";
  if (obj(after) || obj(before))
    return [
      ...new Set([
        ...Object.keys(obj(before) ? before : {}),
        ...Object.keys(obj(after) ? after : {}),
      ]),
    ].flatMap((k) =>
      differences(
        obj(before) ? before[k] : undefined,
        obj(after) ? after[k] : undefined,
        field ? `${field}.${k}` : k,
      ),
    );
  if (before === after) return [];
  const display = (v: unknown) =>
    typeof v === "number" || typeof v === "boolean"
      ? v
      : /(?:^|\.)(?:os|arch|machine_id|project_id|id)$/u.test(field)
        ? String(v)
        : "已隐藏";
  return [
    {
      field,
      change:
        before === undefined
          ? "add"
          : after === undefined
            ? "remove"
            : "change",
      ...(before !== undefined ? { before: display(before) } : {}),
      ...(after !== undefined ? { after: display(after) } : {}),
    },
  ];
}
export function planWorkerFile(
  root: string,
  dataDir: string,
  raw: unknown,
  config: WorkerOnboardingConfig,
  launch = false,
): WizardFilePlan {
  const { machine_id, project_id } = config.worker;
  const name = `worker-${machine_id}-${project_id}.yaml`;
  const draft = snapshot(root, name),
    live = snapshot(root, "runtime-workers.yaml");
  if (draft.bytes) {
    const previous = parseWorkerOnboarding(draft.parsed, dataDir);
    if (
      previous.worker.machine_id !== machine_id ||
      previous.worker.project_id !== project_id ||
      (launch && previous.digest !== config.digest)
    )
      onboardingFail("worker_config_conflict");
  } else if (launch) onboardingFail("worker_config_changed");
  checkWorkerDraft(config, live.parsed, dataDir, "applied");
  const before = live.bytes ? parseRuntimeWorkers(live.parsed, dataDir) : [];
  const target = (w: RuntimeWorker) =>
    w.machine_id === machine_id && w.project_id === project_id;
  if (before.find(target)?.allow_remote_launch)
    onboardingFail("worker_already_enabled");
  const priorDigest = withWorkerBindingCheck(
    root,
    config,
    dataDir,
    false,
    (d) => d,
  );
  const reservation = { config, dataDir, priorDigest };
  if (!launch) {
    const diff = differences(draft.parsed, raw);
    return {
      binding: reservation,
      name,
      revision: draft.revision,
      bytes:
        !diff.length && draft.bytes ? draft.bytes : Buffer.from(stringify(raw)),
      guardName: "runtime-workers.yaml",
      guardRevision: live.revision,
      diff,
    };
  }
  const doc = parseDocument(
    live.bytes?.toString("utf8") ?? "version: 1\nmachines: []\n",
  );
  const machines = (live.parsed?.machines ?? []) as {
    id: string;
    projects: { project_id: string }[];
  }[];
  const index = machines.findIndex((m) => m.id === machine_id);
  const incoming =
    config.runtime.machines[0] ?? onboardingFail("worker_config_invalid");
  const binding =
    (incoming.projects as Record<string, unknown>[])[0] ??
    onboardingFail("worker_config_invalid");
  const next = { ...binding, allow_remote_launch: true };
  if (index === -1) doc.addIn(["machines"], { ...incoming, projects: [next] });
  else {
    const p = machines[index]?.projects.findIndex(
      (p) => p.project_id === project_id,
    );
    if (p === undefined) return onboardingFail("worker_config_invalid");
    if (p === -1) doc.addIn(["machines", index, "projects"], next);
    else {
      const key = ["machines", index, "projects", p, "allow_remote_launch"];
      // An anchored scalar may be referenced outside this project. Never edit it in place.
      const gate = doc.getIn(key, true);
      if (isScalar(gate) && gate.anchor)
        return onboardingFail("worker_shared_yaml");
      doc.setIn(key, true);
    }
  }
  const bytes = Buffer.from(doc.toString());
  const merged = parseRuntimeWorkers(parse(bytes.toString("utf8")), dataDir);
  if (
    !isDeepStrictEqual(merged.filter(target), [
      { ...config.worker, allow_remote_launch: true },
    ]) ||
    !isDeepStrictEqual(
      merged.filter((w) => !target(w)),
      before.filter((w) => !target(w)),
    )
  )
    return onboardingFail("worker_config_conflict");
  return {
    binding: reservation,
    name: "runtime-workers.yaml",
    revision: live.revision,
    guardName: name,
    guardRevision: draft.revision,
    bytes,
    diff: [
      ...(index < 0 ? [{ field: "machine", change: "add" }] : []),
      ...(!machines[index]?.projects.some((p) => p.project_id === project_id)
        ? [{ field: "project_binding", change: "add" }]
        : []),
      { field: "allow_remote_launch", change: "false → true" },
    ],
  };
}
/** Keep the file lock until the caller's authorization/audit transaction commits. */
export function commitWorkerFile(
  root: string,
  plan: WizardFilePlan,
  transaction: (apply: () => void) => void = (apply) => apply(),
) {
  const { config, dataDir, priorDigest } = plan.binding;
  withWorkerBindingCheck(root, config, dataDir, true, (digest) => {
    if (digest !== priorDigest) return onboardingFail("worker_preview_stale");
    publishWorkerFile(root, plan, transaction);
  });
}
function publishWorkerFile(
  root: string,
  plan: WizardFilePlan,
  transaction: (apply: () => void) => void,
) {
  if (plan.bytes.length > 65536) onboardingFail("worker_private_file_invalid");
  const dir = new CpuProfileDirectory(root);
  try {
    const lock = dir.lock(true);
    try {
      if (!lock.acquire()) onboardingFail("worker_busy");
      const current = () => {
        lock.verify();
        const source = snapshot(root, plan.name);
        if (
          source.revision !== plan.revision ||
          snapshot(root, plan.guardName).revision !== plan.guardRevision
        )
          onboardingFail("worker_preview_stale");
        return source.bytes;
      };
      const id = randomUUID(),
        tmp = `stage-${id}`,
        backup = `${plan.name}.${id}.bak`,
        target = dir.at(plan.name);
      let installed = false,
        staged = false;
      try {
        transaction(() => {
          const original = current();
          if (original?.equals(plan.bytes)) return;
          if (original) dir.publish(backup, original);
          dir.publish(tmp, plan.bytes);
          staged = true;
          current();
          if (original) {
            renameSync(dir.at(tmp), target);
            staged = false;
          } else linkSync(dir.at(tmp), target); // Atomic create, never clobber another writer.
          installed = true;
          if (staged) {
            unlinkSync(dir.at(tmp));
            staged = false;
          }
          fsyncSync(dir.fd);
        });
      } catch (error) {
        if (installed) {
          lock.verify();
          if (plan.revision === null) unlinkSync(target);
          else renameSync(dir.at(backup), target);
          fsyncSync(dir.fd);
        }
        throw error;
      } finally {
        if (staged) unlinkSync(dir.at(tmp));
      }
    } finally {
      lock.close();
    }
  } finally {
    dir.close();
  }
}
