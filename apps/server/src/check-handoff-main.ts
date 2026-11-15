import { installSqliteWarningFilter } from "@cardigan/host/warnings";
import { resolveDataDirectory } from "@cardigan/runtime-herdr";
import type { HandoffRequest } from "./check-handoff.js";
import { checkArtifact } from "./check-handoff-artifact.js";
import { requestCheckControl } from "./check-handoff-control.js";

installSqliteWarningFilter();
const [action, project, generation, width, ...extra] = process.argv.slice(2);
try {
  if (action === "artifact" && project === undefined) {
    process.stdout.write(`${JSON.stringify(await checkArtifact())}\n`);
  } else {
    if (
      extra.length ||
      (width !== undefined &&
        (action !== "measure" || !/^[1-9]\d*$/u.test(width))) ||
      !action ||
      !project ||
      !["begin", "status", "measure", "stop", "resume"].includes(action) ||
      (["begin", "status"].includes(action)
        ? generation !== undefined
        : !/^[1-9]\d*$/u.test(generation ?? ""))
    )
      throw new Error("参数无效");
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const result = await requestCheckControl(
        resolveDataDirectory(),
        {
          action: action as HandoffRequest["action"],
          project,
          ...(generation ? { generation: Number(generation) } : {}),
          ...(width ? { width: Number(width) } : {}),
        },
        abort.signal,
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
} catch {
  process.stderr.write(
    "检查移交未确认。用 artifact 或 begin|status <project>，measure|stop|resume <project> <generation>；measure 可追加不超过原目标容量的宽度。失败后先查状态，围栏不自动恢复。\n",
  );
  process.exitCode = 1;
}
