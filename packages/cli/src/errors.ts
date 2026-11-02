/** What kind of problem a CodeloomError is, for callers that branch on it (the dashboard API maps
 * "not-indexed" to a 409 that tells the user to run "codeloom index"). */
export type CodeloomErrorCode = "not-indexed";

/** An error whose message is meant for the user; the CLI prints it without a stack trace.
 * exitCode is what the CLI process exits with (default 1); a data/usage problem exits 2. */
export class CodeloomError extends Error {
  readonly exitCode: number;
  readonly code?: CodeloomErrorCode;

  constructor(message: string, opts?: { exitCode?: number; code?: CodeloomErrorCode }) {
    super(message);
    this.name = "CodeloomError";
    this.exitCode = opts?.exitCode ?? 1;
    if (opts?.code) this.code = opts.code;
  }
}

/** A data or usage problem (missing/old/invalid .codeloom files, a bad flag value): exit code 2. */
export function dataError(message: string, opts?: { code?: CodeloomErrorCode }): CodeloomError {
  return new CodeloomError(message, { exitCode: 2, ...opts });
}

/** What the CLI prints for an error: a CodeloomError's message as is; anything else as a short
 * "unexpected error" note (with the stack only when debugging). */
export function formatError(err: unknown, debug: boolean): string {
  if (err instanceof CodeloomError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  const text = `codeloom hit an unexpected error: ${message}\nPlease report it with the command you ran.`;
  return debug && err instanceof Error && err.stack ? `${text}\n\n${err.stack}` : text;
}
