import { randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { lstat, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { loadModelLaunchConfig, recordLaunchNotice } from "@cardigan/host";
import { validateLaunchSecrets } from "@cardigan/roles";
import { Store } from "@cardigan/store";
import { isMap, isScalar, parseDocument } from "yaml";
import { loadConfig, loadSecrets } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { resolveGlobalActor } from "./host.js";
import type { CliIo } from "./io.js";
import type { LaunchPaths } from "./paths.js";

export async function reload(paths: LaunchPaths, io: CliIo) {
  resolveGlobalActor(io);
  validateLaunchSecrets(await loadConfig(paths), await loadSecrets(paths, io));
  const now = new Date();
  await utimes(paths.launchFile, now, now);
  io.stdout("预检通过，已通知运行中的服务重载启动配置。");
  return EXIT.ok;
}

export async function setModel(
  paths: LaunchPaths,
  io: CliIo,
  alias: string,
  id: string,
) {
  resolveGlobalActor(io);
  if (!id.trim() || Array.from(id).some((c) => c < " " || c === "\u007f"))
    throw new CliError("模型 ID 无效", EXIT.usage);
  const path = paths.launchFile;
  if (!(await lstat(path)).isFile())
    throw new CliError("set-model 只修改普通启动配置文件", EXIT.usage);
  const original = await readFile(path, "utf8");
  const doc = parseDocument(original, { prettyErrors: false });
  if (doc.errors.length)
    throw new CliError("launch.yaml 格式不正确", EXIT.usage);
  const definition = doc.getIn(["models", alias], true);
  if (!isMap(definition) || definition.anchor)
    throw new CliError("请指定独立的模型别名", EXIT.usage);
  const field = doc.getIn(["models", alias, "id"], true);
  if (!isScalar(field) || typeof field.value !== "string" || field.anchor)
    throw new CliError("找不到可独立修改的模型别名 ID", EXIT.usage);
  if (field.value === id) {
    io.stdout("模型未变化");
    return EXIT.ok;
  }
  const previous = field.value;
  const suffix = randomUUID();
  const backup = `${path}.${suffix}.bak`,
    temp = `${path}.${suffix}.tmp`;
  const privateFile = { mode: 0o600, flag: "wx" };
  await writeFile(backup, original, privateFile);
  io.stdout(`原配置已备份：${backup}`);
  field.value = id;
  const candidate = doc.toString();
  const config = await loadModelLaunchConfig(doc.toJS(), paths.dataDir);
  validateLaunchSecrets(config, await loadSecrets(paths, io));
  const store = Store.open({ dataDir: paths.dataDir });
  try {
    await writeFile(temp, candidate, privateFile);
    // BEGIN IMMEDIATE serializes local writers. Check the original bytes again
    // after preflight, then publish via one same-directory rename.
    store.uow.run((tx) => {
      if (!store.listProjects().length)
        throw new CliError("没有可记录换模知会的项目", EXIT.usage);
      if (readFileSync(path, "utf8") !== original)
        throw new CliError("启动配置已变化，请重新预检", EXIT.usage);
      recordLaunchNotice(
        store,
        tx,
        "launch_model_changed",
        `本机管理员已将模型 ${alias} 从 ${previous} 换为 ${id}。新 Run 使用新配置。`,
      );
      renameSync(temp, path);
    });
  } finally {
    store.close();
    await rm(temp, { force: true });
  }
  io.stdout("启动配置已替换，已触发重载并记录知会。");
  return EXIT.ok;
}
