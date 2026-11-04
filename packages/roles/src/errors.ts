/**
 * Errors raised by launch configuration parsing and compilation.
 *
 * The codes are stable so the CLI can print a hint and pick an exit code
 * without matching on message text. Messages never carry secret values.
 */
export type LaunchConfigErrorCode =
  | "invalid_config"
  | "unknown_profile"
  | "unknown_provider"
  | "missing_secret"
  | "invalid_import";

export class LaunchConfigError extends Error {
  readonly code: LaunchConfigErrorCode;
  readonly details: readonly string[];

  constructor(
    code: LaunchConfigErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "LaunchConfigError";
    this.code = code;
    this.details = details;
  }
}
