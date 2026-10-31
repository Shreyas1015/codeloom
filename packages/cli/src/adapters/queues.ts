import ts from "typescript";
import type { QueueOp } from "../store/schemas.js";
import { enclosingSymbol, lastName, lineOf, stringValue, walk } from "./ast.js";
import type { AdapterContext, ParsedFile } from "./types.js";

const RECEIVER_RE = /(channel|^ch$|amqp|rabbit|broker|queue|mq|publisher|consumer)/i;

export function detectQueues(file: ParsedFile, ctx: AdapterContext): QueueOp[] {
  if (!file.sf || ![...ctx.deps].some((d) => /amqp|rabbit/i.test(d))) return [];
  const out: QueueOp[] = [];
  walk(file.sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (!RECEIVER_RE.test(lastName(node.expression.expression))) return;
    const at = { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) };
    const [a0, a1, a2] = node.arguments;
    switch (node.expression.name.text) {
      case "sendToQueue": {
        const q = stringValue(a0);
        if (q) out.push({ queue: q, op: "publish", at });
        break;
      }
      case "publish": {
        const exchange = stringValue(a0);
        const key = stringValue(a1);
        if (exchange === undefined || key === undefined) break;
        // Fanout exchanges publish with an empty routing key; fall back to the exchange name.
        const queue = exchange && key ? `${exchange}:${key}` : exchange || key;
        if (queue) out.push({ queue, op: "publish", exchange, routingKey: key, at });
        break;
      }
      case "consume": {
        const q = stringValue(a0);
        if (q) out.push({ queue: q, op: "consume", at });
        break;
      }
      case "bindQueue": {
        const queue = stringValue(a0);
        const exchange = stringValue(a1);
        const routingKey = stringValue(a2);
        if (queue === undefined || exchange === undefined || routingKey === undefined) break;
        out.push({ queue, op: "bind", exchange, routingKey, at });
        break;
      }
      // assertExchange and anything else: not a recognised op — ignored (no case, no default).
    }
  });
  return out;
}
