import { createInterface } from "node:readline/promises";
import type { HeadlessRun } from "../claude/headless.js";
import { dataError } from "../errors.js";
import { checkPrPromptText } from "../mcp/prompts.js";
import { buildReview } from "../review/build.js";
import { renderReviewDraft, renderReviewMarkdown } from "../review/markdown.js";
import { type CheckPacket, packetForReview, packetText } from "../review/packet.js";
import { loadPrReview, rememberPacket } from "../review/saved.js";
import type { Review } from "../review/types.js";
import { loadWorkspace } from "../workspace/repos.js";

/** "markdown" is the 0.5 draft (spec §2); "full" the 0.4 layout (every touched chain, journey/spec table). */
export type ReviewFormat = "markdown" | "full" | "json";

export interface ReviewOptions {
  base: string;
  format?: ReviewFormat;
  link?: string;
  /** `--repo <id>`: diff only this repo (a folder of separate repos); see review/build.ts pickTarget. */
  repo?: string;
}

/** --format: "markdown" (default), "full" or "json"; anything else is a usage error (exit 2). */
export function parseReviewFormat(raw: string | undefined): ReviewFormat {
  if (raw === undefined) return "markdown";
  if (raw === "markdown" || raw === "full" || raw === "json") return raw;
  throw dataError(`--format must be "markdown", "full" or "json", got "${raw}".`);
}

const repoOpts = (opts: ReviewOptions): { repoId?: string } => (opts.repo !== undefined ? { repoId: opts.repo } : {});

/** `codeloom review --base <ref> [--repo <id>]`: the PR block for `merge-base(<ref>, HEAD)..HEAD`. The
 * default is the 0.5 draft (what it writes, where it matters, risks, code to check, the changed path) — or,
 * when Claude saved a checked review for this HEAD (save_pr_review), that review ("Checked by Claude").
 * `--format full` is the 0.4 block — the same renderer `codeloom snapshot-site` uses for a hosted PR's
 * description. `--format json` prints the `Review` model instead (what `snapshot` writes to `review.json`).
 * `--link` adds the "Open the full review map" line, for when you already have one. */
export function runReview(start: string, opts: ReviewOptions, warn: (line: string) => void = () => {}): { review: Review; output: string } {
  const review = buildReview(start, opts.base, repoOpts(opts));
  if (opts.format === "json") return { review, output: JSON.stringify(review, null, 2) };
  if (opts.format === "full") return { review, output: renderReviewMarkdown(review, { link: opts.link, builtFor: review.head.slice(0, 7) }) };
  return { review, output: renderReviewDraft(review, { link: opts.link, checked: loadPrReview(start, review.head, warn) }) };
}

// ---- Claude checks the draft (spec §3) -------------------------------------------------------------------------

/** The interactive question; the default answer is no. */
export const CHECK_PR_QUESTION = "Let Claude check this PR now? (uses your Claude Code)";
/** The only tool the headless check may call: the packet is inlined in the prompt, so it needs nothing else. */
export const CHECK_PR_ALLOWED_TOOLS = ["mcp__codeloom__save_pr_review"];

export interface ReviewRunOptions extends ReviewOptions {
  /** `--packet`: print the check packet (JSON) instead of the block. */
  packet?: boolean;
  /** `--check`: let Claude check the draft now, without asking (the consent). */
  check?: boolean;
}

export interface ReviewRunDeps {
  /** findClaude(): the claude CLI's path, or null when it is not on PATH. */
  claude: string | null;
  /** runClaudeHeadless (tests fake it). Only ever called after `--check` or a yes to CHECK_PR_QUESTION. */
  run: (run: HeadlessRun) => Promise<{ exitCode: number; output: string }>;
  /** stdin and stdout are a terminal: only then is the user asked. */
  interactive: boolean;
  confirm: (question: string, def: boolean) => Promise<boolean>;
  print: (text: string) => void;
  /** One-line warnings (e.g. an unreadable saved review); defaults to `print`. The CLI sends them to stderr. */
  warn?: (line: string) => void;
}

/** Control characters (terminal escapes and the like) dropped from text Claude printed; newlines and tabs kept. */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** A yes/no question on the terminal (closed again right after, so the process can exit). */
export async function terminalConfirm(question: string, def: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [${def ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
    return answer === "" ? def : answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Whether stdin and stdout are both a terminal (someone is there to answer). */
export function isInteractive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/** Runs the check-pr prompt headless (packet inlined, only save_pr_review allowed) in the workspace root, then
 * prints the checked block — or, when Claude saved nothing, the draft and a line saying so. Without claude on
 * PATH it starts nothing and prints the prompt to run instead. */
async function checkNow(start: string, review: Review, packet: CheckPacket, opts: ReviewRunOptions, deps: ReviewRunDeps): Promise<void> {
  const prompt = checkPrPromptText(packet);
  if (deps.claude === null) {
    deps.print(`Claude Code is not on PATH. Run this in Claude Code (with codeloom connected) to check the PR:\n\n${prompt}`);
    return;
  }
  const { root } = loadWorkspace(start);
  const result = await deps.run({ prompt, allowedTools: CHECK_PR_ALLOWED_TOOLS, cwd: root, claudeBin: deps.claude });
  const checked = loadPrReview(start, review.head, deps.warn ?? deps.print);
  if (checked) {
    deps.print(renderReviewDraft(review, { link: opts.link, checked }));
    return;
  }
  deps.print(renderReviewDraft(review, { link: opts.link }));
  deps.print(
    `\nClaude did not save a review (exit ${result.exitCode}). Is codeloom connected in .mcp.json ("codeloom init")?` +
      (result.output.trim() !== "" ? `\nClaude said: ${stripControl(result.output).trim().slice(0, 500)}` : ""),
  );
}

/** `codeloom review` as the CLI runs it: `--packet` prints the check packet; `--check` lets Claude check the draft
 * now; otherwise the block is printed and, on a terminal with claude on PATH and no checked review for HEAD yet,
 * the user is asked CHECK_PR_QUESTION (default no). Claude is never started without `--check` or that yes. */
export async function runReviewCommand(start: string, opts: ReviewRunOptions, deps: ReviewRunDeps): Promise<void> {
  if (opts.packet && opts.check) throw dataError("Use --packet or --check, not both.");
  const format = opts.format ?? "markdown";
  if ((opts.packet || opts.check) && format !== "markdown") throw dataError(`--${opts.packet ? "packet" : "check"} works only with the default --format markdown.`);

  if (!opts.packet && !opts.check && format !== "markdown") {
    deps.print(runReview(start, opts, deps.warn ?? deps.print).output);
    return;
  }

  const review = buildReview(start, opts.base, repoOpts(opts));
  const packetOf = (): CheckPacket => {
    const packet = packetForReview(start, review);
    rememberPacket(start, packet);
    return packet;
  };

  if (opts.packet) {
    deps.print(packetText(packetOf()));
    return;
  }
  if (opts.check) {
    await checkNow(start, review, packetOf(), opts, deps);
    return;
  }

  const checked = loadPrReview(start, review.head, deps.warn ?? deps.print);
  deps.print(renderReviewDraft(review, { link: opts.link, checked }));
  if (checked || !deps.interactive || deps.claude === null) return;
  if (!(await deps.confirm(CHECK_PR_QUESTION, false))) return;
  await checkNow(start, review, packetOf(), opts, deps);
}
