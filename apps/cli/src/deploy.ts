import {
  changeDeployment,
  type DeploymentControlRequest,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import { hasToken, resolveDataDir } from "./host.js";
import type { CliIo } from "./io.js";

export async function runDeployCommand(args: readonly string[], io: CliIo) {
  if (hasToken(io))
    throw new CliError("部署托底仅限人类操作，Token 模式不可用", EXIT.usage);
  const [action, ...rest] = args;
  const count =
    action === "adopt" ? 2 : action === "pin" ? 1 : action === "unpin" ? 0 : -1;
  if (
    count < 0 ||
    rest.length !== count + 2 ||
    rest[count] !== "--reason" ||
    !rest[count + 1]?.trim()
  )
    throw new CliError(
      "用法：cardigan deploy adopt <from-sha> <to-sha> | pin <sha> | unpin --reason <人工核对说明>（每项均须 --reason）",
      EXIT.usage,
    );
  const reason = rest[count + 1] as string;
  const request: DeploymentControlRequest =
    action === "adopt"
      ? { action, from: rest[0] as string, to: rest[1] as string, reason }
      : action === "pin"
        ? { action, sha: rest[0] as string, reason }
        : { action: "unpin", reason };
  const dataDir = resolveDataDir(io);
  const store = Store.open({ dataDir, migrate: false });
  try {
    if (!store.getProject("cardigan"))
      throw new CliError("部署托底只服务自举项目 cardigan", EXIT.usage);
    const result = await changeDeployment(
      store,
      dataDir,
      { kind: "human", project_id: "cardigan" },
      request,
    );
    io.stdout(JSON.stringify(result ?? { action: "unpin", unchanged: true }));
    return EXIT.ok;
  } finally {
    store.close();
  }
}
