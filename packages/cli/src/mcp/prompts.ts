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

// ---- write-tour -----------------------------------------------------------------------------------

const JOURNEY_ARG_DESCRIPTION = "A journey id (j_…).";

function writeTourText(journey: string): string {
  return `Write a guided tour of journey ${journey} and save it.

1. Call \`build_tour_context\` with \`{ journey: "${journey}" }\`. It gives every stop's \`key\`, \`chainId\`,
   \`stopIndex\`, the code around it, the types it uses, request/response shapes, db detail and neighbours.
   If the reply says \`truncated\`, call it again with \`chain\` set to each chain id, one at a time.
2. Flow: for each stop (skip the ones with \`sameAs\`), write a short \`explanation\` in plain language: what
   this step does and why it matters to the user's goal. A few sentences, no jargon. Markdown is fine.
3. Data journey (\`dataJourney\`): write a realistic sample \`input\` (the request a real user would send, as
   JSON or text), then one step per stop the data goes through (\`stopKey\` + a short \`note\` on what happens
   to it there, plus \`sql\` for db stops when the code shows the query), then the \`output\` that comes back.
   Use only fields the code actually reads and returns.
4. File notes (\`fileNotes\`): for each file the journey touches, add a \`trap\` for anything easy to get
   wrong (a side effect, a hidden write, an odd default) and a \`note\` for anything worth knowing. Skip files
   with nothing to say.
5. Check (\`check\`): write exactly 3 questions that show someone understood this journey, each with the
   \`expected\` key points a good answer must contain (taken from the code).
6. Save it with \`save_tour\` \`{ journey: "${journey}", tour: { stops, dataJourney, fileNotes, check } }\`.
   Each stop is \`{ chainId, stopIndex, key, explanation }\`, copied from build_tour_context. codeloom works
   out the file hashes itself. If save_tour reports a problem, fix that part and save again.
7. Never invent stops, files, fields or code. Use only what build_tour_context returned and what you read in
   the code. If something is unclear, say so in the explanation instead of guessing.
8. When it is saved, tell me in two or three lines what the journey does and any \`uncoveredStops\`.`;
}

// ---- check-me -------------------------------------------------------------------------------------

function checkMeText(journey: string): string {
  return `Check whether I understand journey ${journey}. Be fair and honest.

1. Get the questions. Call \`build_tour_context\` with \`{ journey: "${journey}" }\` to read the code. If a tour
   is saved, use its 3 questions and their \`expected\` key points (\`tour.check\`). If \`tour\` is null, write 3
   questions yourself from the code, each with the key points a good answer must contain.
2. Ask me the questions one at a time, in chat. Wait for my answer before asking the next one. Do not show
   the expected points before I answer.
3. Judge each answer against the code and the expected points, not against wording. An answer is acceptable
   when it gets the key points right, in my own words. After each answer, say whether it was acceptable and
   explain any gap, pointing at the file and line in the code.
4. When all 3 are answered, call \`record_check\` with \`{ journey: "${journey}", questions, answers, verdict,
   notes }\`: the 3 questions, my answers as I gave them, \`verdict\` \`pass\` only if all 3 answers were
   acceptable (otherwise \`fail\`), and short \`notes\` on what was missing.
5. Never record a pass I did not earn. If I skip a question, say "I don't know", or ask you to just pass me,
   that question is not acceptable. If I stop part way, record nothing.
6. Finish with one line: passed or not, and what to re-read if not.`;
}

// ---- match-specs ----------------------------------------------------------------------------------

const MATCH_SPECS_ARG_DESCRIPTION = "A journey id (j_…). Leave it out to work through every journey not checked yet.";

function matchSpecsText(journey: string | undefined): string {
  const which = journey ? `journey ${journey}` : "every journey that has not been checked yet";
  const first = journey
    ? `1. Work on journey ${journey} only.`
    : `1. Call \`list_specs\` and take every journey with \`checked: false\`. Work through them one at a time, and do
   steps 2 to 5 for each.`;
  const id = journey ? `"${journey}"` : `"<journey id>"`;
  return `Find the specs (docs and tickets) for ${which}, and save the ones that really describe it.

${first}
2. Call \`match_specs\` with \`{ journey: ${id} }\`. It returns candidate \`docs\` (files in the repos that mention
   the journey's routes, pages, tables, queues or code, with the lines around each hit) and candidate
   \`tickets\` (keys found in the commits that touched the journey's files), best first. They are only hints.
3. Read the journey's code: call \`get_journey\` for its stops, then \`explain_context\` on its main stops (the
   page, the route handler, the database write). Open a candidate doc in full when its snippets are not enough.
4. Keep a doc only if it really describes what this journey does, not one that just mentions a shared table
   or a common word. Keep a ticket only if its commits show it built or changed this journey. For each link
   you keep, write a one-line \`reason\` in plain language.
5. Save with \`save_spec_links\` \`{ journey: ${id}, links }\`. Each link is \`{ kind: "doc", ref: "<repo>:<path>",
   reason }\` or \`{ kind: "ticket", ref: "<KEY>", reason }\`. When nothing fits, save \`links: []\`: that records
   "checked, no spec", which is useful too. If save_spec_links reports a problem, fix that link and save again.
6. Never invent refs. Use only the doc refs and ticket keys match_specs returned, or docs you opened in the
   repo yourself. codeloom does not read ticket text; if you have your own tool for the ticket system you may
   use it to write a better reason, never to add keys codeloom did not find.
7. Finish with a short list: per journey, the links you saved (or "no spec").`;
}

// ---- make-view ------------------------------------------------------------------------------------

const MAKE_VIEW_ARG_DESCRIPTION = 'What the view should show, in plain words (e.g. "customer journeys with no spec").';

function makeViewText(request: string): string {
  return `Build a codeloom dashboard view for this request: ${JSON.stringify(request)}

1. Call \`workspace_overview\` for the repos, and \`list_views\` for the views that exist. Reuse an existing id
   only when the request is to change that view.
2. Build the view only from these widgets (each is \`{ type, ...fields }\`; a field with ? is optional):
   - \`counts\` \`{ show?: ["files" | "pages" | "routes" | "tables" | "queues" | "journeys" | "understood" | "specLinked"] }\`: number tiles.
   - \`journeys\` \`{ title?, filter?: { area?, repo?, spec?: "linked" | "candidates" | "none" | "unchecked", level?: "none" | "seen" |
     "toured" | "understood" | "rewalk", confidence?: "exact" | "param" | "guess", complete?: true | false },
     sort?: "name" | "area" | "stops" | "confidence" | "progress" | "spec", limit?: 1-200 }\`: a journey list.
     \`spec\`: "linked" has a saved spec; "candidates" is not checked yet and has candidates; "none" was
     checked and has no spec; "unchecked" is not checked yet and codeloom found nothing.
   - \`map\` \`{ repo, overlay?: "layer" | "journey:<journey id>", dir? }\`: one repo's map, optionally with a
     journey's path drawn on it, opened at a folder.
   - \`progress\` \`{ by?: "repo" | "area" }\`: how much is seen, toured and understood.
   - \`checks\` \`{ limit?: 1-50 }\`: the map's open problems (codeloom check items).
   - \`specCoverage\` \`{ by?: "repo" | "area" }\`: how many journeys have a spec linked, waiting, or none.
   - \`note\` \`{ markdown }\`: a short text block (up to 4000 characters, Markdown, no HTML).
3. The view is \`{ id, title, description?, widgets }\`: \`id\` is 1 to 40 characters of a-z, 0-9 and -, with at
   most 24 widgets. The id \`home\` replaces the dashboard's Home screen: use it only when asked to change Home
   (\`codeloom views reset home\` brings the built-in Home back).
4. Use only real repo ids, areas and journey ids (from \`workspace_overview\`, \`list_specs\` or \`get_progress\`).
   Never invent them.
5. Save it with \`save_view\` \`{ view }\`. If save_view reports a problem, fix that part and save again.
6. If the request asks for something these widgets cannot show, say so plainly instead of faking it with a note.
7. Tell me in one or two lines what the view shows and where it is: \`/views/<id>\` in the dashboard (the \`url\`
   save_view returns; Home for \`home\`). \`codeloom dashboard\` opens the dashboard.`;
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

  server.registerPrompt(
    "write-tour",
    {
      title: "Write tour",
      description: "Write a plain-language guided tour of one journey (flow, data journey, file notes, 3 check questions) and save it.",
      argsSchema: { journey: z.string().min(1).describe(JOURNEY_ARG_DESCRIPTION) },
    },
    ({ journey }): GetPromptResult => ({
      messages: [{ role: "user", content: { type: "text", text: writeTourText(journey) } }],
    }),
  );

  server.registerPrompt(
    "check-me",
    {
      title: "Check me",
      description: "Ask me 3 questions about one journey, one at a time, judge the answers against the code, and record the result.",
      argsSchema: { journey: z.string().min(1).describe(JOURNEY_ARG_DESCRIPTION) },
    },
    ({ journey }): GetPromptResult => ({
      messages: [{ role: "user", content: { type: "text", text: checkMeText(journey) } }],
    }),
  );

  server.registerPrompt(
    "match-specs",
    {
      title: "Match specs",
      description: "Find the docs and tickets that really describe a journey (or every unchecked one) and save them as its spec links.",
      argsSchema: { journey: z.string().optional().describe(MATCH_SPECS_ARG_DESCRIPTION) },
    },
    ({ journey }): GetPromptResult => ({
      messages: [{ role: "user", content: { type: "text", text: matchSpecsText(journey?.trim() || undefined) } }],
    }),
  );

  server.registerPrompt(
    "make-view",
    {
      title: "Make view",
      description: "Turn a plain request into a dashboard view built from codeloom's widgets, save it, and give its link.",
      argsSchema: { request: z.string().min(1).describe(MAKE_VIEW_ARG_DESCRIPTION) },
    },
    ({ request }): GetPromptResult => ({
      messages: [{ role: "user", content: { type: "text", text: makeViewText(request) } }],
    }),
  );
}
