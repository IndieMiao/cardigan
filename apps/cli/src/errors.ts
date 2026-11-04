/** Errors the CLI reports to the user, with a fixed process exit code. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly details: readonly string[];

  constructor(
    message: string,
    exitCode: number,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  notInstalled: 127,
} as const;
