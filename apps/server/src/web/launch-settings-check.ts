import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { probeModel } from "@cardigan/host";
import {
  getHarnessAdapter,
  type Harness,
  requiredSecretKeys,
  resolveProfile,
} from "@cardigan/roles";
import type { Store } from "@cardigan/store";
import { HttpRejection } from "./http.js";
import {
  invalid,
  publicFields,
  type SettingsFile,
} from "./launch-settings-file.js";

function cliPath(harness: Harness) {
  const { binary } = getHarnessAdapter(harness);
  for (const dir of (process.env.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)) {
    const path = join(dir, binary);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      /* next PATH directory */
    }
  }
  return null;
}
async function cliVersion(path: string, harness: Harness) {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      path,
      getHarnessAdapter(harness).versionArgs,
      { timeout: 5000, maxBuffer: 8192, env: { PATH: process.env.PATH } },
    );
    // Never retain an arbitrary version banner or stderr.
    return (
      /\b(\d{1,5}\.\d{1,5}\.\d{1,5})\b/u.exec(`${stdout}\n${stderr}`)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}
export type CheckMode = "metadata" | "online";
export class ProfileChecks {
  private readonly active = new Map<string, Promise<void>>();
  private shutdown?: { firstFailure?: { reason: unknown } };
  constructor(
    private readonly store: Store,
    private readonly currentVersion: () => string,
  ) {}
  private readonly versions = new Map<
    Harness,
    { stamp: string; version: Promise<string | null> }
  >();
  // The full view reads the version of each installed host binary once per inode
  // generation. This does not run a profile, inject its environment or contact an endpoint.
  async cli(harness: Harness) {
    const path = cliPath(harness);
    if (!path) return { path: null, version: null };
    const st = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (!st) return { path: null, version: null };
    const stamp = `${path}/${st.dev}/${st.ino}/${st.ctimeNs}`;
    let entry = this.versions.get(harness);
    if (entry?.stamp !== stamp) {
      entry = { stamp, version: cliVersion(path, harness) };
      this.versions.set(harness, entry);
    }
    return { path, version: await entry.version };
  }

  beginShutdown() {
    this.shutdown ??= {};
  }
  async drain() {
    const results = await Promise.allSettled(this.active.values());
    const failure =
      this.shutdown?.firstFailure ??
      results.find((r) => r.status === "rejected");
    if (failure) throw failure.reason;
  }
  latest(profile: string) {
    const row = this.store.database
      .prepare(
        "SELECT id,profile,snapshot,kind,started_at,finished_at,result FROM launch_profile_checks WHERE profile=? ORDER BY started_at DESC,rowid DESC LIMIT 1",
      )
      .get(profile);
    if (!row) return null;
    const result = row.result ? JSON.parse(String(row.result)) : null;
    return {
      id: row.id,
      version: row.snapshot,
      mode: row.kind,
      started_at: row.started_at,
      finished_at: row.finished_at,
      status: result
        ? result.ok
          ? "passed"
          : "failed"
        : this.active.has(profile)
          ? "running"
          : "interrupted",
      problems: result?.problems ?? [],
      cli_version: result?.cli_version ?? null,
    };
  }
  start(file: SettingsFile, profile: string, mode: CheckMode, actor: string) {
    if (
      publicFields(profile, file.secrets) !== profile ||
      !Object.hasOwn(file.config.profiles, profile)
    )
      throw invalid("profile");
    if (this.active.has(profile))
      throw new HttpRejection(409, "check_running", "该配置已有检查在进行");
    const resolved = resolveProfile(file.config, profile);
    if (mode === "online") {
      const provider = resolved.provider;
      const url = provider?.definition.base_url;
      // probeModel sends credentials to this literal endpoint. A snapshot of a
      // masked destination is not informed confirmation of that destination.
      if (
        !provider ||
        !url ||
        publicFields(provider.name, file.secrets) !== provider.name ||
        publicFields(url, file.secrets) !== url
      )
        throw invalid("base_url");
    }
    const id = randomUUID();
    this.store.database
      .prepare(
        "INSERT INTO launch_profile_checks(id,profile,snapshot,kind,actor,started_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, profile, file.version, mode, actor, new Date().toISOString());
    const work = Promise.resolve().then(async () => {
      const problems: string[] = [];
      let version: string | null = null;
      try {
        const cli = await this.cli(resolved.profile.harness);
        version = cli.version;
        if (!cli.path) problems.push("cli_missing");
        const missing = requiredSecretKeys(file.config, profile).some(
          (key) => !Object.hasOwn(file.secrets, key) || !file.secrets[key],
        );
        if (missing) problems.push("missing_secret");
        if (mode === "metadata") {
          const alias = file.raw.profiles[profile].model;
          const model = Object.hasOwn(file.config.models ?? {}, alias)
            ? file.config.models?.[alias]
            : undefined;
          if (model)
            for (const key of [
              "context_window",
              "max_output_tokens",
              "reasoning_efforts",
            ] as const)
              if (model[key] === undefined) problems.push(`missing_${key}`);
        } else if (this.currentVersion() !== file.version) {
          problems.push("stale_snapshot");
        } else if (
          !missing &&
          (await probeModel(
            resolved,
            file.secrets,
            false,
            file.config.launch_check,
          ))
        )
          problems.push("online_failed");
      } catch {
        problems.push(mode === "online" ? "online_failed" : "check_failed");
      }
      this.store.database
        .prepare(
          "UPDATE launch_profile_checks SET finished_at=?,result=? WHERE id=?",
        )
        .run(
          new Date().toISOString(),
          JSON.stringify({
            ok: !problems.length,
            problems,
            cli_version: publicFields(version, file.secrets),
          }),
          id,
        );
    });
    this.active.set(profile, work);
    void work.then(
      () => this.active.delete(profile),
      (reason: unknown) => {
        // The HTTP listener may still be draining requests when this check leaves active.
        if (this.shutdown) this.shutdown.firstFailure ??= { reason };
        this.active.delete(profile);
      },
    );
    return { id, profile, mode, version: file.version, status: "running" };
  }
}
