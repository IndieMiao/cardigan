import { homedir } from "node:os";
import { join } from "node:path";
import {
  type GithubMergeGateExecutor,
  loadMacosCheckProfiles,
  MacosCheckService,
  type MergeGateConfiguration,
} from "@cardigan/host";
import type { Store } from "@cardigan/store";
import type { AuthorCheckGit } from "./author-prechecks.js";
import type { ServerEnv } from "./config.js";
import type { GitBinding, ServerGit } from "./git.js";

/** C-611: macOS checks use the project's GitHub executor unless the host file names one. */
export function serverMacosChecks(options: {
  store: Store;
  dataDir: string;
  env: ServerEnv;
  git: GitBinding &
    Partial<AuthorCheckGit> &
    Partial<Pick<ServerGit, "prepareDeliveryCandidate">>;
  configuration: MergeGateConfiguration;
}) {
  const { store, dataDir, git, configuration } = options;
  const configPath = join(
    options.env.CARDIGAN_CONFIG_DIR ??
      join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "cardigan",
      ),
    "macos-checks.yaml",
  );
  const github = (value: unknown) =>
    (value as { type?: string } | undefined)?.type === "github"
      ? (value as GithubMergeGateExecutor)
      : undefined;
  return new MacosCheckService({
    store,
    dataDir,
    profiles: () => loadMacosCheckProfiles(configPath),
    executor: (project, name) => {
      if (name) return github(configuration.forExecutor?.(name));
      const settings = configuration.forProject(project);
      return settings.status === "enabled"
        ? github(settings.executor)
        : undefined;
    },
    prepare: async (job) => {
      const project = git.projectOf(job.project_id);
      if (!project || !git.prepareDeliveryCandidate)
        throw new Error("macOS check Git unavailable");
      const prepared = await git.prepareDeliveryCandidate(
        project,
        job.delivery_id,
        job.head_sha,
      );
      return {
        sha: prepared.candidate_sha,
        tree: prepared.tree_sha,
        baseline: project.base_branch,
      };
    },
    push: async (id, input) => {
      const project = git.projectOf(id);
      if (!project || !git.pushCheckCandidate)
        throw new Error("macOS check Git unavailable");
      return git.pushCheckCandidate(project, input);
    },
    remove: async (id, input) => {
      const project = git.projectOf(id);
      return project && git.deleteCheckCandidate
        ? git.deleteCheckCandidate(project, input)
        : false;
    },
    isBaselineAncestor: async (id, sha, branch) => {
      const project = git.projectOf(id);
      return (
        !!project &&
        !!git.isBaselineAncestor &&
        git.isBaselineAncestor(project, sha, branch)
      );
    },
  });
}
