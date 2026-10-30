/** An error whose message is meant for the user; the CLI prints it without a stack trace. */
export class CodeloomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeloomError";
  }
}

/** What the CLI prints for an error: a CodeloomError's message as is; anything else as a short
 * "unexpected error" note (with the stack only when debugging). */
export function formatError(err: unknown, debug: boolean): string {
  if (err instanceof CodeloomError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  const text = `codeloom hit an unexpected error: ${message}\nPlease report it with the command you ran.`;
  return debug && err instanceof Error && err.stack ? `${text}\n\n${err.stack}` : text;
}
