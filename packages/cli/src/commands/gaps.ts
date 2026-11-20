import { spawn as nodeSpawn } from "node:child_process";
import { codeloomServeCommand } from "../claude/headless.js";
import { capGaps, type Gap, loadGaps, type MapGapsResult } from "../map/gaps.js";

// 0.6 spec §5: `codeloom gaps` lists what codeloom could not settle about the map; `codeloom ask` answers it with
// Claude. The interview needs you, so it is an interactive Claude Code session (the map-interview prompt as the
// first message), never a headless run, and codeloom starts it only after you said yes (as in 0.5).

export const INTERVIEW_COMMAND = "/mcp__codeloom__map-interview";
const MCP_ADD = "claude mcp add codeloom -- npx -y codeloom serve";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function gapLines(g: Gap, i: number): string[] {
  const affects = `${g.kind}; ${count(g.journeys ?? 0, "journey")}, ${count(g.chains ?? 0, "chain")}`;
  return [
    `${String(i + 1).padStart(2)}. ${g.question} (${affects})`,
    ...g.evidence.map((e) => `      ${e}`),
    ...(g.more ? [`      … and ${g.more} more`] : []),
    ...(g.suggest ?? []).map((a) => `      proposed answer: ${a}`),
  ];
}

/** `codeloom gaps`: the capped list (`--json` prints exactly what map_gaps returns). */
export function runGaps(start: string, opts: { json?: boolean } = {}): string {
  const r: MapGapsResult = capGaps(loadGaps(start).gaps);
  if (opts.json) return JSON.stringify(r);
  if (r.open === 0) return NOTHING_OPEN;
  return [
    `${count(r.open, "open question")} about the map, the ones touching most journeys first:`,
    "",
    ...r.gaps.flatMap(gapLines),
    ...(r.next ? ["", `${r.open - r.shown} more not shown: they come up as these are answered.`] : []),
    "",
    `Answer them with Claude: run ${INTERVIEW_COMMAND} in Claude Code (codeloom ask shows how).`,
  ].join("\n");
}

/** `codeloom ask` when codeloom does not start Claude: how to start the map interview in Claude Code. */
export function runAsk(start: string): string {
  return askText(loadGaps(start).gaps.length);
}

function askText(open: number): string {
  if (open === 0) return NOTHING_OPEN;
  return [
    `${count(open, "open question")} about the map (codeloom gaps lists them).`,
    "",
    "Answer them with Claude Code, in this folder:",
    `  ${INTERVIEW_COMMAND}`,
    "",
    "Claude asks one short question at a time, proposes an answer from the code, and fixes the map after each",
    "answer (the dashboard updates by itself).",
    `If Claude Code does not list codeloom's tools, add them first: ${MCP_ADD}`,
  ].join("\n");
}

const NOTHING_OPEN = "No open questions: codeloom settled everything it found in this map.";

export interface AskDeps {
  /** The `claude` CLI on PATH (findClaude), or null. */
  claude: string | null;
  /** stdin and stdout are a terminal: someone is there to say yes, and to answer Claude. */
  interactive: boolean;
  confirm: (question: string, def: boolean) => Promise<boolean>;
  /** Run `bin args` in `cwd` with this terminal (stdio inherited); resolves to its exit code. */
  spawn: (bin: string, args: string[], cwd: string) => Promise<number>;
  print: (text: string) => void;
}

/** The arguments of the interview session: an interactive `claude` whose first message is the map-interview
 * prompt, with this codeloom's MCP server added (the user's own settings and servers stay). The prompt goes
 * first: `--mcp-config <configs...>` takes every argument after it, so a prompt placed after it would be read as
 * one more config. */
export function interviewArgs(serve = codeloomServeCommand()): string[] {
  return [INTERVIEW_COMMAND, "--mcp-config", JSON.stringify({ mcpServers: { codeloom: serve } })];
}

/** `codeloom ask`: with open questions, a terminal and `claude` on PATH, ask "Start Claude Code …?" (default no)
 * and on yes start the interview session in `start`; else print how to start it. Never starts Claude without
 * that yes. Returns the exit code. */
export async function runAskCommand(start: string, deps: AskDeps): Promise<number> {
  const open = loadGaps(start).gaps.length;
  if (open === 0 || deps.claude === null || !deps.interactive) {
    deps.print(askText(open));
    return 0;
  }
  const yes = await deps.confirm(`Start Claude Code to go through ${count(open, "open question")} now?`, false);
  if (!yes) {
    deps.print(askText(open));
    return 0;
  }
  deps.print(`Starting Claude Code with ${INTERVIEW_COMMAND} …`);
  return deps.spawn(deps.claude, interviewArgs(), start);
}

/** The real spawn for runAskCommand: this terminal is Claude Code's until it exits. */
export function spawnInherit(bin: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(bin, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
