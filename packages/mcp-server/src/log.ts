/** Structured, redacted logging: never a token, never a request body (§9.1, §14). */
export type LogEntry = {
  readonly timestamp?: string;
  readonly role?: string;
  readonly pid?: number;
  readonly request_id?: string;
  readonly phases_ms?: Readonly<Record<string, number>>;
  readonly event: "http" | "tool" | "auth";
  readonly method?: string | undefined;
  readonly tool?: string | undefined;
  readonly assignment_id?: string | undefined;
  /** `ok`, or a domain error code. */
  readonly code: string;
  readonly status?: number | undefined;
  readonly duration_ms?: number | undefined;
};

export type Logger = (entry: LogEntry) => void;

/** Default logger: one JSON line per event on stdout. */
export const stdoutLogger: Logger = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

/** Collect entries in memory; used by tests. */
export function memoryLogger(): { log: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { log: (entry) => entries.push(entry), entries };
}
