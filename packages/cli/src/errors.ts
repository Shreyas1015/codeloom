/** An error whose message is meant for the user; the CLI prints it without a stack trace. */
export class CodeloomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeloomError";
  }
}
