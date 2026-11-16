import { homedir } from "node:os";
import { join } from "node:path";
import {
  ConfigProbe,
  GithubProbe,
  loadProbeProfiles,
  type MergeGateConfiguration,
  ProbeService,
} from "@cardigan/host";
import type { Store } from "@cardigan/store";
import type { AuthorCheckGit } from "./author-prechecks.js";
import type { ServerEnv } from "./config.js";
import type { GitBinding } from "./git.js";

export function serverProbes(options: {
  store: Store;
  dataDir: string;
  env: ServerEnv;
  git: GitBinding & Partial<AuthorCheckGit>;
  configuration: MergeGateConfiguration;
  releaseSha: string;
}) {
  const { store, dataDir, git } = options;
  const configPath = join(
    options.env.CARDIGAN_CONFIG_DIR ??
      join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "cardigan",
      ),
    "probes.yaml",
  );
  const github = new GithubProbe({
    store,
    dataDir,
    config: (name) => {
      const config = options.configuration.forExecutor?.(name);
      return config?.type === "github" ? config : undefined;
    },
    prepare: async (job) => {
      const project = git.projectOf(job.project_id);
      const assignment = store.uow.read((tx) =>
        tx.assignments.get(job.project_id, job.assignment_id),
      );
      if (
        !project ||
        !assignment ||
        !git.preparePrecheck ||
        !git.checkHead ||
        (await git.checkHead(job.project_id, assignment)) !== job.head_sha
      )
        throw new Error("Probe source changed");
      const prepared = await git.preparePrecheck(
        project,
        job.assignment_id,
        job.head_sha,
        job.id,
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
        throw new Error("Probe Git unavailable");
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
  return new ProbeService({
    store,
    dataDir,
    profiles: () => loadProbeProfiles(configPath),
    head: async (project, assignment) => {
      if (!git.checkHead) throw new Error("Probe Git unavailable");
      return git.checkHead(project, assignment);
    },
    adapters: {
      github,
      config: new ConfigProbe({
        dataDir,
        releaseSha: options.releaseSha,
        entry: new URL("./config-probe-worker.js", import.meta.url),
      }),
    },
  });
}
