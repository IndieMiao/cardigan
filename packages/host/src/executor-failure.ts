/** Inspect diagnostics only in memory; callers persist fixed messages below. */
export function classifyExecutorFailure(
  error: unknown,
): "executor_unreachable" | "repository_missing" | undefined {
  if (!(error instanceof Error)) return undefined;
  const stderr = (error as Error & { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" ? stderr : error.message;
  if (
    /ssh: connect to host|Could not resolve hostname|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Permission denied \((?:publickey|[^)]*keyboard-interactive)[^)]*\)|Connection (?:timed out|refused|reset|closed)|Network is unreachable|No route to host|Connection to .+ (?:closed|lost)|Timeout, server .+ not responding|client_loop: send disconnect: Broken pipe/iu.test(
      text,
    )
  )
    return "executor_unreachable";
  if (
    /does not appear to be a git repository|not a git repository/iu.test(text)
  )
    return "repository_missing";
  return undefined;
}
