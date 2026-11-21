import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  launchRevision,
  parseCachedLaunchConfig,
  publishModelFile,
  selectableLaunchConfig,
  stageModelLaunchConfig,
  withLaunchSnapshot,
} from "@cardigan/host";
import {
  type LaunchConfig,
  LaunchConfigError,
  requiredSecretKeys,
  validateLaunchSecrets,
} from "@cardigan/roles";
import type { ReadRepositories, Store, WebSession } from "@cardigan/store";
import { z } from "zod";
import type { LaunchGeneration } from "../live-launch.js";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";
import {
  type Change,
  candidate,
  changeSchema,
  providerUsers,
} from "./launch-settings-change.js";
import { ProfileChecks, providerCheck } from "./launch-settings-check.js";
import {
  digest,
  invalid,
  privateEnv,
  providerEndpoint,
  publicFields,
  readLaunchSettings,
  references,
  type SettingsFile,
  snapshot,
  stale,
} from "./launch-settings-file.js";
import {
  installSecrets,
  planKeys,
  plannedSecrets,
  readSecretsText,
  SecretsUnsettled,
  secretTimes,
  secretValues,
  settleSecretIntents,
  settleSecrets,
  withdrawSecrets,
} from "./launch-settings-secrets.js";

const versionSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const previewBody = z.strictObject({
  version: versionSchema,
  change: changeSchema,
});
const confirmBody = z.strictObject({
  version: versionSchema,
  preview_id: z.uuid(),
  /** C-549: values for exactly the keys the preview set; never stored or echoed. */
  secrets: secretValues.optional(),
});
const checkBody = z.union([
  z.strictObject({
    version: versionSchema,
    profile: z.string(),
    mode: z.enum(["metadata", "online"]),
  }),
  z.strictObject({
    version: versionSchema,
    provider: z.string(),
    mode: z.literal("online"),
  }),
]);
/** Nothing changed: our own partial write was undone (C-549). */
const writeFailed = () =>
  new HttpRejection(500, "write_failed", "写入失败，已恢复原文件，没有改动");
/** V-2708: the outcome is not known yet; the next read settles it from the files. */
const writeUnknown = () =>
  new HttpRejection(
    500,
    "write_unsettled",
    "写入结果暂未确认，请刷新后查看密钥状态",
  );
function envView(
  env: Readonly<Record<string, string>>,
  secrets: Record<string, string>,
) {
  return Object.entries(env).map(([name, value]) => ({
    name: publicFields(name, secrets) as string,
    value: privateEnv(name, value, secrets) ? null : value,
  }));
}

function redactedFields(
  values: Record<string, unknown>,
  secrets: Record<string, string>,
) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      publicFields(value, secrets),
    ]),
  );
}

export class LaunchSettings {
  private readonly previews = new Map<
    string,
    { change: Change; version: string; owner: string; after: string }
  >();
  readonly checks: ProfileChecks;
  constructor(
    private readonly store: Store,
    private readonly dir: string,
    private readonly dataDir: string,
    readonly effective: () => LaunchConfig,
    private readonly adopt: (generation: LaunchGeneration) => void,
  ) {
    this.checks = new ProfileChecks(store, () => this.snapshot());
    // V-2713: settle what an interrupted confirmation left behind before
    // anything reads it. Bookkeeping only (the files are not touched); a
    // failure here is retried by the next settings read.
    try {
      settleSecretIntents(store);
    } catch {
      /* retried before the next read */
    }
  }
  private snapshot() {
    return snapshot(this.dir, launchRevision(this.store));
  }
  private file() {
    // V-2708: an interrupted secrets.env write is applied or undone first.
    settleSecretIntents(this.store);
    return withLaunchSnapshot(this.store, this.dir, this.dataDir, (fence) => ({
      ...readLaunchSettings(this.dir, this.dataDir, fence.revision),
      fence,
    }));
  }
  private async read() {
    const f = this.file();
    const { config, secrets } = f;
    const refs = this.store.uow.read((tx) => references(this.store, tx));
    const profiles = await Promise.all(
      Object.entries(config.profiles).map(async ([name, p]) => {
        const raw = f.raw.profiles[name];
        const alias =
          raw.model && Object.hasOwn(config.models ?? {}, raw.model)
            ? raw.model
            : null;
        const last = this.checks.latest(name);
        // Hand-written args/config may embed credentials; only disclose semantic parameters.
        const data = {
          name,
          provider: p.provider ?? null,
          model_alias: alias,
          model_id: p.model ?? null,
          metadata: alias ? config.models?.[alias] : null,
          parameters: {
            effort: p.effort ?? null,
            permission_mode: p.permission_mode ?? null,
            auto_update: p.auto_update ?? null,
            provider_flag: p.provider_flag ?? null,
            custom_args_count: raw.args?.length ?? 0,
            custom_config_count: Object.keys(raw.config ?? {}).length,
          },
          cli: await this.checks.cli(p.harness),
          secrets: requiredSecretKeys(config, name).map((key) => ({
            key,
            set: Object.hasOwn(secrets, key) && !!secrets[key],
          })),
          references: refs.get(name) ?? [],
        };
        return {
          ...redactedFields(data, secrets),
          harness: p.harness,
          last_check: last && {
            ...last,
            cli_version: publicFields(last.cli_version, secrets),
          },
        };
      }),
    );
    const times = secretTimes(this.store);
    const providers = Object.entries(config.providers).map(([id, p]) => {
      const users = providerUsers(f, id);
      const last = this.checks.latest(providerCheck(id));
      return {
        ...redactedFields(
          {
            id,
            name: p.name ?? p.codex?.name ?? id,
            base_url: providerEndpoint(config, id),
            harness: p.harness ?? null,
            api: p.api ?? null,
            profiles: users.profiles,
            models: users.models,
            secrets: Object.entries(p.secret_env).map(([env, key]) => ({
              env,
              key,
              set: Object.hasOwn(secrets, key) && !!secrets[key],
              updated_at: times.get(key) ?? null,
            })),
          },
          secrets,
        ),
        secret_env: publicFields(p.secret_env, secrets, true),
        env: envView(p.env, secrets),
        last_check: last && {
          ...last,
          cli_version: publicFields(last.cli_version, secrets),
        },
      };
    });
    return {
      version: f.version,
      profiles,
      providers,
      models: publicFields(config.models ?? {}, secrets, true),
      secret_keys: publicFields(Object.keys(secrets), secrets),
    };
  }
  private guardDelete(
    f: SettingsFile,
    change: Change,
    tx: Pick<ReadRepositories, "roles" | "employees">,
  ) {
    if (change.op !== "delete_profile") return;
    const refs = references(this.store, tx).get(change.name);
    if (refs?.length)
      throw new HttpRejection(
        409,
        "profile_in_use",
        "仍有角色版本或员工使用该配置",
        publicFields({ references: refs }, f.secrets),
      );
  }
  /** The candidate must hold both before and after the secrets.env write. */
  private checkSecrets(
    f: SettingsFile,
    next: LaunchConfig,
    secrets: Record<string, string>,
  ) {
    try {
      validateLaunchSecrets(next, secrets);
      validateLaunchSecrets(f.config, secrets);
    } catch {
      throw invalid();
    }
  }
  private preview(body: unknown, owner: string) {
    const parsed = previewBody.safeParse(body);
    if (!parsed.success) throw invalid();
    const { version, change } = parsed.data,
      f = this.file();
    if (version !== f.version) throw stale();
    this.store.uow.read((tx) => this.guardDelete(f, change, tx));
    const { diff, text, raw, plan } = candidate(f, change);
    let next: LaunchConfig;
    try {
      next = parseCachedLaunchConfig(raw, this.dataDir);
    } catch {
      throw invalid();
    }
    this.checkSecrets(f, next, plannedSecrets(f.secrets, plan));
    const id = randomUUID();
    if (this.previews.size >= 256)
      this.previews.delete(this.previews.keys().next().value ?? "");
    this.previews.set(id, { change, version, owner, after: digest(text) });
    return { preview_id: id, version, diff };
  }
  private async confirm(
    body: unknown,
    key: unknown,
    owner: string,
    authorize: () => WebSession,
  ) {
    const parsed = confirmBody.safeParse(body);
    if (
      !parsed.success ||
      typeof key !== "string" ||
      !key.trim() ||
      key.length > 256
    )
      throw invalid();
    const { version, preview_id: id } = parsed.data,
      requestKey = digest(`${owner}:${key}`);
    const replay = (allowUnsettled: boolean) => {
      const receipt = this.store.database
        .prepare(
          "SELECT operation,snapshot,installed FROM launch_web_changes WHERE request_key=?",
        )
        .get(requestKey);
      if (receipt) {
        if (receipt.operation !== id || receipt.snapshot !== version)
          throw new HttpRejection(
            409,
            "idempotency_conflict",
            "此幂等键已用于其它预览",
          );
        if (receipt.installed) return true;
        if (!allowUnsettled) throw stale();
      }
      return false;
    };
    const success = { ok: true, preview_id: id };
    // A settled receipt is scoped to this session and request; later disk edits cannot undo it.
    if (replay(true)) return success;
    const f = this.file();
    const path = realpathSync(f.path);
    if (replay(false)) return success;
    const pending = this.previews.get(id);
    if (
      !pending ||
      pending.owner !== owner ||
      pending.version !== version ||
      f.version !== version
    )
      throw stale();
    const { change } = pending;
    this.store.uow.read((tx) => this.guardDelete(f, change, tx));
    const { text, raw, yaml, plan } = candidate(f, change);
    // Values for exactly the keys the confirmed preview names, nothing else.
    const values = parsed.data.secrets ?? {};
    const { set, clear } = planKeys(plan);
    if (
      Object.keys(values).length !== set.length ||
      set.some((k) => !Object.hasOwn(values, k))
    )
      throw invalid("secrets");
    // The host reloads via the refresh-aware catalog loader, not the offline preview cache.
    const staged = yaml
      ? await stageModelLaunchConfig(raw, this.dataDir).catch(() => {
          throw invalid();
        })
      : { config: f.config, catalog: undefined };
    const secrets = plannedSecrets(f.secrets, plan, values);
    this.checkSecrets(f, staged.config, secrets);
    const actor = authorize().member_id ?? "human";
    if (replay(false)) return success; // a concurrent identical request finished during preflight
    if (digest(text) !== pending.after || this.snapshot() !== version)
      throw stale();
    // A reference can be added while awaiting the catalog. Reject before even backing up,
    // then check once more under the SQLite publication lock.
    this.store.uow.read((tx) => this.guardDelete(f, change, tx));
    const receipt = (installed: boolean) =>
      this.store.database
        .prepare(
          "INSERT INTO launch_web_changes(operation,request_key,snapshot,action,target,actor,created_at,installed) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          requestKey,
          version,
          change.op,
          change.name,
          actor,
          new Date().toISOString(),
          installed ? 1 : 0,
        );
    // C-549: secrets.env first. V-2713: with a YAML step it only gains
    // brand-new keys (see `candidate`), so the old YAML never reads them; a
    // failed YAML step takes exactly those keys back. Whether the write took
    // effect is read from its marker line (see `installSecrets`).
    let files: string | undefined;
    const unsettled = () => {
      // Renamed but not recorded: with a YAML step, take the new keys back.
      if (yaml)
        try {
          withdrawSecrets(this.store, this.dir, id, values);
          return writeFailed();
        } catch {
          /* still unknown */
        }
      return writeUnknown();
    };
    if (set.length || clear.length) {
      const now = new Date().toISOString();
      try {
        files = installSecrets(this.store, this.dir, this.dataDir, f.fence, {
          operation: id,
          original: readSecretsText(this.dir),
          values,
          clear,
          yaml,
          reserve: () => {
            const journal = this.store.database.prepare(
              "INSERT INTO launch_secret_changes(operation,key,action,actor,created_at) VALUES(?,?,?,?,?)",
            );
            for (const k of set) journal.run(id, k, "set", actor, now);
            for (const k of clear) journal.run(id, k, "clear", actor, now);
            if (!yaml) receipt(false);
          },
        });
      } catch (error) {
        if (error instanceof HttpRejection) throw error;
        if (error instanceof SecretsUnsettled) throw unsettled();
        throw writeFailed();
      }
    }
    if (yaml) {
      const suffix = randomUUID(),
        temp = `${path}.${suffix}.tmp`,
        opts = { flag: "wx", mode: 0o600 };
      let revision: number;
      try {
        // V-2708: only our own secrets.env rename may differ from the
        // previewed snapshot. The catalog, the revision and every other file
        // must still be exactly those the preview was validated against.
        const fence = files === undefined ? f.fence : { ...f.fence, files };
        writeFileSync(`${path}.${suffix}.bak`, f.original, opts);
        writeFileSync(temp, text, opts);
        revision = publishModelFile(
          this.store,
          path,
          temp,
          id,
          f.original,
          text,
          this.dataDir,
          fence,
          staged.catalog,
          "人员已确认修改启动配置，新运行将使用更新后的配置。",
          {
            hostProfiles: Object.keys(
              selectableLaunchConfig({ config: staged.config, secrets })
                .profiles,
            ),
            reserve: () => receipt(false),
            checkReferences: (tx) => this.guardDelete(f, change, tx),
          },
        );
      } catch (error) {
        // V-2713: our YAML is in place but not recorded. The next read
        // settles its receipt; the same confirmation then answers ok.
        let installed = false;
        try {
          installed = readFileSync(path, "utf8") === text;
        } catch {
          /* unreadable: not ours */
        }
        if (installed) throw writeUnknown();
        if (files !== undefined) {
          try {
            withdrawSecrets(this.store, this.dir, id, values);
          } catch {
            throw writeUnknown();
          }
          if (error instanceof HttpRejection) throw error;
          // Another writer changed the launch files between the two steps.
          if (error instanceof LaunchConfigError) throw stale();
          throw writeFailed();
        }
        if (error instanceof HttpRejection) throw error;
        if (this.snapshot() !== version) throw stale();
        throw error;
      } finally {
        rmSync(temp, { force: true });
      }
      // The YAML is installed, so its new keys stand; if this cannot record
      // that now, the next read settles the intent the same way.
      if (files !== undefined)
        try {
          settleSecrets(this.store, id);
        } catch {
          /* settled as applied by the next read */
        }
      this.adopt({ config: staged.config, secrets, revision });
    }
    this.previews.delete(id);
    return success;
  }
  async serve(
    rest: string,
    req: IncomingMessage,
    res: ServerResponse,
    authorize: () => WebSession,
    owner: string,
  ) {
    if (req.headers.authorization !== undefined)
      throw new HttpRejection(403, "unauthorized", "仅限人员登录会话");
    if (rest === "" || rest === "/profiles") {
      if (req.method !== "GET") methodNotAllowed(["GET"]);
      if (!rest) {
        const body = await this.read();
        authorize();
        sendJson(res, 200, body);
      } else {
        const profiles = Object.keys(this.effective().profiles);
        sendJson(res, 200, { profiles });
      }
      return;
    }
    if (!["/preview", "/confirm", "/checks"].includes(rest))
      throw new HttpRejection(404, "not_found", "接口不存在");
    if (req.method !== "POST") methodNotAllowed(["POST"]);
    const body = await readJsonBody(req);
    const actor = authorize().member_id ?? "human";
    if (rest === "/preview") sendJson(res, 200, this.preview(body, owner));
    else if (rest === "/confirm")
      sendJson(
        res,
        200,
        await this.confirm(
          body,
          req.headers["idempotency-key"],
          owner,
          authorize,
        ),
      );
    else {
      const input = checkBody.safeParse(body);
      if (!input.success) throw invalid();
      const f = this.file();
      if (input.data.version !== f.version) throw stale();
      sendJson(
        res,
        202,
        "provider" in input.data
          ? this.checks.startProvider(f, input.data.provider, actor)
          : this.checks.start(f, input.data.profile, input.data.mode, actor),
      );
    }
  }
}
