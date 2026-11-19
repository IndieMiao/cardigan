import { randomUUID } from "node:crypto";
import { lstat, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { loadModelLaunchConfig } from "@cardigan/host";
import { validateLaunchSecrets } from "@cardigan/roles";
import { Store } from "@cardigan/store";
import { isMap, isScalar, parseDocument } from "yaml";
import { loadConfig, loadSecrets } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { resolveGlobalActor } from "./host.js";
import type { CliIo } from "./io.js";
import {
  publishModelFile,
  readSettledModelFile,
} from "./launch-model-intent.js";
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
  const file = await realpath(path);
  const store = Store.open({ dataDir: paths.dataDir });
  try {
    const original = readSettledModelFile(store, file);
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
    try {
      await writeFile(temp, candidate, privateFile);
      publishModelFile(
        store,
        file,
        temp,
        suffix,
        original,
        candidate,
        `本机管理员已将模型 ${alias} 从 ${previous} 换为 ${id}。新 Run 使用新配置。`,
      );
    } finally {
      await rm(temp, { force: true });
    }
  } finally {
    store.close();
  }
  io.stdout("启动配置已替换，已触发重载并记录知会。");
  return EXIT.ok;
}
