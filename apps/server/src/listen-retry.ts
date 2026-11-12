interface ListenRetryOptions {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly warn: (message: string) => void;
}

/** Only bind failures are retried; callers retain ownership of startup cleanup. */
export function createListenRetry(options: ListenRetryOptions) {
  // Both listeners share a monotonic deadline, starting at the first conflict.
  let deadline: number | undefined;
  return async function listen<T>(
    port: number,
    start: () => Promise<T>,
  ): Promise<T> {
    for (;;) {
      try {
        return await start();
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "EADDRINUSE"
        )
          throw error;

        deadline ??= performance.now() + options.timeoutMs;
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
          throw Object.assign(
            new Error(
              `启动失败：等待 ${options.timeoutMs} 毫秒后，端口 ${port} 仍被占用（EADDRINUSE）。`,
              { cause: error },
            ),
            { code: "EADDRINUSE", port },
          );
        }
        const delayMs = Math.min(options.intervalMs, Math.ceil(remainingMs));
        options.warn(
          `端口 ${port} 被占用（EADDRINUSE），${delayMs} 毫秒后重试，剩余等待时间 ${Math.ceil(remainingMs)} 毫秒。`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };
}
