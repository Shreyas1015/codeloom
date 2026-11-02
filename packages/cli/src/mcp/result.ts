import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { CodeloomError } from "../errors.js";

/** Success: one text item with pretty JSON + structuredContent (the same object). */
export function ok(result: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

function zodMessage(err: ZodError): string {
  const parts = err.issues.map((i) => {
    const path = i.path.map(String).join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
  return `Invalid input: ${parts.join("; ")}`;
}

/** Failure: isError true, one text item with the message. CodeloomError → its message; ZodError →
 * "Invalid input: <path>: <message>; …"; anything else → "Unexpected error: <message>". */
export function fail(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof CodeloomError) message = err.message;
  else if (err instanceof ZodError) message = zodMessage(err);
  else message = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap a tool handler: returns ok(await fn(args)) or fail(err). Never throws. */
export function withErrors<A>(
  fn: (args: A) => Promise<Record<string, unknown>> | Record<string, unknown>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}
