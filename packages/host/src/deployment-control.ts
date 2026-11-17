import { join } from "node:path";
import {
  type Actor,
  controlDeployment,
  type DeploymentControl,
} from "@cardigan/domain";
import { CentralGitTransport } from "@cardigan/git-transport";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { acquireDeploymentCapacity } from "./deployment-capacity.js";

export type DeploymentControlRequest =
  | {
      readonly action: "adopt";
      readonly from: string;
      readonly to: string;
      readonly reason: string;
    }
  | { readonly action: "pin"; readonly sha: string; readonly reason: string }
  | { readonly action: "unpin"; readonly reason: string };

/** Shares the deployment/check exclusion lock; no pin changes during a deployment. */
export async function changeDeployment(
  store: Store,
  dataDir: string,
  actor: Actor,
  request: DeploymentControlRequest,
) {
  if (actor.kind !== "human" || actor.project_id !== "cardigan")
    throw new Error("部署托底仅限本项目人类操作");
  const release = acquireDeploymentCapacity(store);
  if (!release) throw new Error("部署或检查正在运行，请结束后重试部署托底操作");
  try {
    let input: DeploymentControl;
    if (request.action === "unpin") input = request;
    else {
      const sha = request.action === "adopt" ? request.to : request.sha;
      if (
        !/^[a-f0-9]{40}$/u.test(sha) ||
        (request.action === "adopt" && !/^[a-f0-9]{40}$/u.test(request.from))
      )
        throw new Error("部署操作需要完整提交 SHA");
      const git = new CentralGitTransport({ dataDir });
      const repository = join(dataDir, "central", "cardigan.git");
      const main = await git.readRef(repository, "refs/heads/main");
      if (
        !main ||
        !(await git.isAncestor(repository, sha, main)) ||
        (request.action === "adopt" &&
          !(await git.isAncestor(repository, request.from, sha)))
      )
        throw new Error("只能认领或固定中心 main 历史中的提交");
      input = { ...request, tree: await git.treeOfCommit(repository, sha) };
    }
    return store.uow.run((tx) => {
      const effect = unwrap(
        controlDeployment(loadCommandState(tx, "cardigan"), actor, input, {
          ids: tx.ids,
          clock: { now: () => new Date().toISOString() },
        }),
      );
      persistEffect(tx, "cardigan", effect);
      return effect.data;
    });
  } finally {
    release();
  }
}
