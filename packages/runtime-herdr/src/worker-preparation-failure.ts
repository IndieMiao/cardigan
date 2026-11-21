/** A failure attributable to the worker or its transport. Construct only after
 * local request/config checks, never for host admission, queue or spawn errors.
 * The message must already be safe to report without raw command output. */
export class WorkerPreparationFailure extends Error {}
