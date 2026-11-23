import {
  type Assignment,
  CheckHeadFailure,
  type CheckHeadReader,
  type ProjectId,
} from "@cardigan/domain";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";

/**
 * C-632: request_check reads the branch HEAD inside the project repository
 * lock. A busy lock is transient, so acceptance retries it before failing.
 * Each attempt keeps the lock's own wait; `totalMs` bounds when another
 * attempt may still start.
 */
export interface CheckHeadRetryOptions {
  /** Attempts including the first; at least 1. */
  readonly attempts: number;
  /** No retry starts once elapsed time plus its backoff reaches this. */
  readonly totalMs: number;
  /** First backoff; doubles per retry, capped at {@link MAX_BACKOFF_MS}. */
  readonly backoffMs: number;
}
export const DEFAULT_CHECK_HEAD_RETRY: CheckHeadRetryOptions = {
  attempts: 3,
  totalMs: 90_000,
  backoffMs: 1_000,
};
const MAX_BACKOFF_MS = 10_000;

export interface CheckHeadRetryIo {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The request_check acceptance reader the MCP tool uses in production. */
export function retryingCheckHeadReader(
  git: {
    checkHead?(project: ProjectId, assignment: Assignment): Promise<string>;
  },
  project: ProjectId,
  options: CheckHeadRetryOptions = DEFAULT_CHECK_HEAD_RETRY,
  io: CheckHeadRetryIo = {},
): CheckHeadReader {
  return {
    head: (assignment) =>
      readCheckHeadWithRetry(
        async () => {
          if (!git.checkHead)
            throw new CheckHeadFailure("environment_unavailable");
          return git.checkHead(project, assignment);
        },
        options,
        io,
      ),
  };
}

export async function readCheckHeadWithRetry(
  read: () => Promise<string>,
  options: CheckHeadRetryOptions = DEFAULT_CHECK_HEAD_RETRY,
  io: CheckHeadRetryIo = {},
): Promise<string> {
  const now = io.now ?? (() => performance.now());
  const sleep =
    io.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      // Only a busy lock is retried; real branch errors fail at once.
      if (!(error instanceof RepositoryLockTimeoutError)) throw error;
      const backoff = Math.min(
        options.backoffMs * 2 ** (attempt - 1),
        MAX_BACKOFF_MS,
      );
      if (
        attempt >= options.attempts ||
        now() - started + backoff >= options.totalMs
      )
        throw new CheckHeadFailure("repository_busy", { cause: error });
      await sleep(backoff);
    }
  }
}
