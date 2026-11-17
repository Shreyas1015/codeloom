import { relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildCheckPacket } from "../../review/packet.js";
import { PrReviewInputShape, rememberPacket, savePrReview } from "../../review/saved.js";
import { loadWorkspace } from "../../workspace/repos.js";
import { withErrors } from "../result.js";
import type { ServerOptions } from "../server.js";

// 0.5 spec §3: Claude checks codeloom's PR draft. pr_check_packet hands it the small packet; save_pr_review is
// the trust boundary for what it sends back (review/saved.ts).

/** The check packet for `merge-base(base, HEAD)..HEAD`, kept in .codeloom/reviews/ for save_pr_review. */
export function prCheckPacketTool(start: string, args: { base: string; repo?: string }): Record<string, unknown> {
  const repoId = args.repo?.trim() || undefined;
  const packet = buildCheckPacket(start, args.base, repoId !== undefined ? { repoId } : {});
  rememberPacket(start, packet);
  return packet as unknown as Record<string, unknown>;
}

export function savePrReviewTool(start: string, input: unknown): Record<string, unknown> {
  const { path, review } = savePrReview(start, input);
  const { root } = loadWorkspace(start);
  return { saved: true, head: review.head, path: relative(root, path).split(/[\\/]/).join("/"), checkedOn: review.savedAt.slice(0, 10) };
}

export function registerPrReviewTools(server: McpServer, opts: ServerOptions): void {
  server.registerTool(
    "pr_check_packet",
    {
      title: "PR check packet",
      description:
        "Everything needed to check codeloom's draft review of a pull request (merge-base(base, HEAD)..HEAD), in at " +
        "most 24,000 characters: the draft as data, the changed hunks of each changed function, the commit messages, " +
        "and `facts` (every name save_pr_review accepts). `cut` lists what was left out to fit. Keeps the packet in " +
        ".codeloom/reviews/ (local, never committed) so save_pr_review can check names against it.",
      inputSchema: {
        base: z.string().min(1).describe('The ref the pull request is compared against, e.g. "origin/main".'),
        repo: z.string().optional().describe("In a folder of separate repos: the repo id the pull request is in."),
      },
    },
    withErrors((args: { base: string; repo?: string }) => prCheckPacketTool(opts.start, args)),
  );

  server.registerTool(
    "save_pr_review",
    {
      title: "Save PR review",
      description:
        "Save your checked review of a pull request to .codeloom/reviews/<head>.json (local, never committed); " +
        "`codeloom review` then shows it as \"Checked by Claude\". `head` must be the packet's head and still HEAD. " +
        "Every name in whereItMatters, writes, beforeDeploying and codeToCheck — and any Name.member or snake_case " +
        "name in free text — must be in the packet, else nothing is saved and the bad names are listed. Detected " +
        "writes, deploy risks and changed functions always stay: an entry for one adds your note beside it, any " +
        "other entry is added. whereItMatters replaces the draft's list. Leave a section out to keep the draft's lines.",
      inputSchema: PrReviewInputShape,
    },
    withErrors((args: unknown) => savePrReviewTool(opts.start, args)),
  );
}
