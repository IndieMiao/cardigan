const SQLITE_EXPERIMENTAL_WARNING =
  "SQLite is an experimental feature and might change at any time";

/** Install before importing the app; this module must not load store/SQLite. */
export function installSqliteWarningFilter(): void {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...args: unknown[]): void => {
    const [typeOrOptions] = args;
    const type =
      warning instanceof Error
        ? warning.name
        : typeof typeOrOptions === "string"
          ? typeOrOptions
          : typeof typeOrOptions === "object" &&
              typeOrOptions !== null &&
              "type" in typeOrOptions
            ? typeOrOptions.type
            : undefined;
    const message = warning instanceof Error ? warning.message : warning;
    if (
      type === "ExperimentalWarning" &&
      message === SQLITE_EXPERIMENTAL_WARNING
    ) {
      return;
    }
    // Preserve every overload, including code, detail and stack constructor.
    Reflect.apply(emitWarning, process, [warning, ...args]);
  };
}
