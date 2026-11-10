/** Thrown when a write method is called on a read-only transaction. */
export class ReadOnlyTransactionError extends Error {
  constructor(what: string) {
    super(`${what} is not allowed in a read transaction`);
    this.name = "ReadOnlyTransactionError";
  }
}
