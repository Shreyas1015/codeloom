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

/** No tool response (text + structuredContent, as JSON) may be larger than this. */
export const MAX_RESPONSE_BYTES = 1_000_000;
/** Room left for the JSON-RPC envelope around a tool result. */
const ENVELOPE_BYTES = 2_048;
/** How many cut lists/strings the note names. */
const NOTE_CUTS = 10;

/** Bytes of the tool response ok(result) would send: the pretty text plus structuredContent. */
export function responseBytes(result: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(ok(result)));
}

type Slot = { holder: Record<string, unknown>; key: string; path: string; size: number };

/** Every array (or string) reachable from `root` through plain objects (not through arrays), biggest first. */
function slots(root: Record<string, unknown>, want: "array" | "string"): Slot[] {
  const out: Slot[] = [];
  const visit = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (want === "array" && Array.isArray(v) && v.length > 0) out.push({ holder: obj, key, path, size: JSON.stringify(v).length });
      else if (want === "string" && typeof v === "string" && v.length > 0) out.push({ holder: obj, key, path, size: v.length });
      else if (v !== null && typeof v === "object" && !Array.isArray(v) && depth < 6) visit(v as Record<string, unknown>, path, depth + 1);
    }
  };
  visit(root, "", 0);
  return out.sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The largest n in [0, max] with fits(n), given fits(0) (binary search). */
function largestFitting(max: number, fits: (n: number) => boolean): number {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A result whose tool response would pass `maxBytes` is cut to fit: the biggest lists first (keeping
 * their head, in order), then the longest strings. The cut copy says so with `truncated: true` and a
 * `truncatedNote` naming what was cut and `narrow`, the tool's own advice on which params narrow the
 * request. A result that fits is returned as is; the input is never mutated. */
export function fitResponse(
  result: Record<string, unknown>,
  narrow: string,
  maxBytes: number = MAX_RESPONSE_BYTES - ENVELOPE_BYTES,
): Record<string, unknown> {
  if (responseBytes(result) <= maxBytes) return result;
  const out = structuredClone(result);
  out.truncated = true;
  out.truncatedNote = "";
  // The note is written last; keep room for it (it is escaped in the text and repeated in structuredContent).
  const budget = maxBytes - 4 * (Buffer.byteLength(narrow) + 120 + NOTE_CUTS * 80);
  const fits = () => responseBytes(out) <= budget;
  const cuts: string[] = [];

  for (const s of slots(out, "array")) {
    if (fits()) break;
    const full = s.holder[s.key] as unknown[];
    const keep = largestFitting(full.length - 1, (n) => {
      s.holder[s.key] = full.slice(0, n);
      return n === 0 || fits();
    });
    s.holder[s.key] = full.slice(0, keep);
    cuts.push(`${s.path}: kept ${keep} of ${full.length}`);
  }
  for (const s of fits() ? [] : slots(out, "string")) {
    if (fits()) break;
    if (s.key === "truncatedNote" && s.holder === out) continue;
    const full = s.holder[s.key] as string;
    const keep = largestFitting(full.length - 1, (n) => {
      s.holder[s.key] = full.slice(0, n);
      return n === 0 || fits();
    });
    s.holder[s.key] = full.slice(0, keep);
    cuts.push(`${s.path}: kept ${keep} of ${full.length} characters`);
  }
  const more = cuts.length > NOTE_CUTS ? `; and ${cuts.length - NOTE_CUTS} more` : "";
  out.truncatedNote = `Response cut to fit the 1 MB limit (${cuts.slice(0, NOTE_CUTS).join("; ")}${more}). ${narrow}`;
  return out;
}

/** What withErrors tells the agent when a tool gives no narrowing advice of its own. */
const DEFAULT_NARROW = "Ask for less: use the tool's filters or a smaller limit.";

/** Wrap a tool handler: returns ok(await fn(args)) or fail(err). Never throws. A response over 1 MB is
 * cut to fit (fitResponse), with `narrow` telling the agent which params narrow it. */
export function withErrors<A>(
  fn: (args: A) => Promise<Record<string, unknown>> | Record<string, unknown>,
  narrow: string = DEFAULT_NARROW,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(fitResponse(await fn(args), narrow));
    } catch (err) {
      return fail(err);
    }
  };
}
