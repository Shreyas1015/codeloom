import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ServerOptions } from "./server.js";

// ---- name-journeys ------------------------------------------------------------------------------

const NAME_JOURNEYS_TEXT = `Group the map's unnamed chains into named user journeys.

1. Call \`list_chains\` with \`unnamed: true, detail: true\` (\`detail: true\` adds each chain's stops). It
   returns one page at a time (\`limit\`, default 100) with a \`total\` and a \`truncated\` flag. Keep calling
   it, growing \`offset\` by the number of chains you got, until \`truncated\` is false, so you see every
   unnamed chain, not just the first page. If a reply has a \`truncatedNote\`, it was cut to fit: use a
   smaller \`limit\`.
2. Look at each chain's \`entry\`, \`routeKey\`, \`tables\` and \`stops\` to see what it does. Group chains that serve
   the same user-facing goal into one journey — e.g. the page, the API route, and the DB write behind
   "create a customer" all belong together.
3. For each group, write a short, plain name a non-technical person would recognize, e.g.
   "Add a customer", "Check out a cart", "Reset password". No jargon, no implementation detail.
4. Set \`area\` to the feature group the journey belongs to, e.g. "Billing", "Customers", "Auth".
5. Save the groups with \`save_journeys\`, using \`create\` ops: \`{ op: "create", name, area, chainIds }\`.
   Put several \`create\` ops in one \`save_journeys\` call (up to 100 ops per call) — save in batches,
   not one journey per call.
6. Never invent chain ids. Only use ids that \`list_chains\` actually returned to you.
7. Some chains won't fit any clear journey. Leave those alone instead of forcing a group, and list their
   chain ids at the end of your reply so I can look at them.`;

// ---- verify-journey -------------------------------------------------------------------------------

const VERIFY_JOURNEY_ARG_DESCRIPTION = "A journey id (j_…) or a chain id (ch_…) to verify.";

function verifyJourneyText(journey: string): string {
  return `Verify journey ${journey} hop by hop against the actual code.

1. Call \`get_journey\` with \`{ id: "${journey}" }\`. It returns the journey's chains and its stops laid
   out by lane (ui / api / code / db / queue), each with a \`ref\` ("<repo>::<nodeId>") when it sits on a
   graph node. If the reply says \`truncated\` (a very large journey), call get_journey again with each
   chain id (ch_…) from the journey's \`chainIds\` and verify one chain at a time.
2. For every stop that has a \`ref\`, call \`explain_context\` with \`{ node: ref }\` to read its source
   code and its neighbors. A stop without a \`ref\` (often a DB or queue stop) still has \`repo\`, \`file\`
   and \`line\`: read the code at that line yourself.
3. Judge each hop against the code you just read, not against the chain's own claim:
   - "agrees" — the code does what the stop says (same route, same table, same call, same file/line).
   - "doubtful (why)" — say exactly what looks wrong, e.g. "doubtful (route path doesn't match the code)".
4. Report your judgments stop by stop, in order, so I can read them.
5. Never change a stop's confidence. Confidence is not yours to change — you are only checking, not
   re-scoring.
6. Only if I agree with your findings, save a short note on the journey with \`save_journeys\`, using an
   \`update\` op: \`{ op: "update", id: "<journey id>", note: "..." }\`. If you were given a chain id
   (ch_…), \`get_journey\` returns \`journey: null\`: take the journey id from \`chains[0].journeys\` (the
   journeys that name this chain; if there are several, ask me which). If that list is empty, the chain is
   in no journey and there is nothing to save — just report. Do not call \`save_journeys\` until I say so.`;
}

// ---- registration -------------------------------------------------------------------------------

/** Prompts are plain text templates: no AI calls, no network access, no map reads. The agent that runs
 * them calls the named tools itself. */
export function registerPrompts(server: McpServer, _opts: ServerOptions): void {
  server.registerPrompt(
    "name-journeys",
    {
      title: "Name journeys",
      description: "Group the map's unnamed chains into short, plain-language user journeys and save them.",
    },
    (): GetPromptResult => ({
      messages: [{ role: "user", content: { type: "text", text: NAME_JOURNEYS_TEXT } }],
    }),
  );

  server.registerPrompt(
    "verify-journey",
    {
      title: "Verify journey",
      description: "Check a journey's chains hop by hop against the code and report what agrees or looks doubtful.",
      argsSchema: { journey: z.string().min(1).describe(VERIFY_JOURNEY_ARG_DESCRIPTION) },
    },
    ({ journey }): GetPromptResult => ({
      messages: [{ role: "user", content: { type: "text", text: verifyJourneyText(journey) } }],
    }),
  );
}
