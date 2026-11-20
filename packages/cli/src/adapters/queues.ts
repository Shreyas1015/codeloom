import { builtinModules } from "node:module";
import ts from "typescript";
import type { ExchangeDef, ExchangeType, Loc, QueueOp } from "../store/schemas.js";
import { className, enclosingSymbol, lastName, lineOf, stringValue, walk } from "./ast.js";
import { importedBindings, isMutated, shadowed } from "./http-calls.js";
import type {
  AdapterContext, DirectOpDraft, ExchangeOpDraft, ParsedFile, PendingLiteral, QueueLiteralExport, QueueOpDraft,
  QueuePendingWrapperCall, QueueResolved, QueueWrapper, QueueWrapperExport, QueueWrapperMethod, QueueWrapperOp, QueueWrapperSlot,
} from "./types.js";

const BUILTIN_MODULES = new Set(builtinModules);

/** Receiver names unambiguous enough to trust on their own, with no further evidence needed (matches
 * amqplib's own vocabulary almost exactly). */
const STRONG_RECEIVER_RE = /(channel|^ch$|amqp|rabbit)/i;
/** Receiver names that are common but ambiguous (a Redis client, a generic job queue, ... can use the
 * same words) — trusted only when there is no evidence they are something else. */
const WEAK_RECEIVER_RE = /(broker|queue|mq|publisher|consumer)/i;
const RECEIVER_RE = new RegExp(`${STRONG_RECEIVER_RE.source}|${WEAK_RECEIVER_RE.source}`, "i");

// ---------------------------------------------------------------------------------------------------
// v0.6 Task B (spec §3), review round 1: on a real AdonisJS/NestJS-style backend, every publish/consume
// goes through the repo's own wrapper (a service class or a helper function around the channel), never
// a direct `channel.sendToQueue(...)` call, and that wrapper is very often injected into (or imported by)
// a completely different file than the one that declares it. This file follows such a wrapper — a
// top-level function/const-arrow or a class method whose body makes one or more recognised amqplib calls
// — and, at every call site to it (on the class itself, an instance created locally or imported, a
// constructor-injected field resolved by its type, a default export, a re-export barrel, ...), substitutes
// the caller's own arguments for the wrapper's forwarded parameters. The literal queue/exchange/
// routing-key name itself may be a string literal, a top-level const, an enum/`as const` object member, or
// a class's static member — resolved within the file, or one import hop away (an exported literal/wrapper
// in another file); an unresolved name records nothing, never guessed.
//
// A wrapper is only ever discovered when its own inner call's receiver looks like a real amqplib channel
// (review round 1, item 3): a value created via `.createChannel()`/`.createConfirmChannel()`, or typed
// `Channel`/`ConfirmChannel`/`ChannelWrapper` — so a same-shaped Redis/ioredis/generic-job-queue
// `publish`/`consume` wrapper records nothing. The direct (non-wrapper) amqplib-call path is unchanged
// from pre-0.6 and still trusts the receiver's name alone, to avoid any regression there.
// ---------------------------------------------------------------------------------------------------

/** How many of each amqplib method's leading arguments carry identity (queue/exchange/routing-key)
 * rather than payload/options: the rest (the message, the handler callback) are never inspected here,
 * except `consume`'s own handler argument, tracked separately (`handlerParamIndex`/`handlerArg`). */
export const AMQP_METHOD_ARGC: Record<QueueWrapperMethod, number> = {
  sendToQueue: 1, publish: 2, consume: 1, bindQueue: 3, assertExchange: 2,
};

/** The most identity arguments any recognised amqplib method needs, lifted well past that (review round
 * 1, minor: a real wrapper forwarding a later parameter, e.g. a 4th `key` argument, must not be missed)
 * — the cap on how many of a cross-file wrapper call's own arguments are worth resolving speculatively
 * (its method is not known until the import is followed in `finalizeEndpoints`). */
const MAX_WRAPPER_ARGS = 6;

export const EXCHANGE_TYPES = new Set<ExchangeType>(["direct", "topic", "fanout", "headers"]);

export function isAmqpMethod(name: string): name is QueueWrapperMethod {
  return name === "sendToQueue" || name === "publish" || name === "consume" || name === "bindQueue" || name === "assertExchange";
}

export function hasAmqpDependency(ctx: AdapterContext): boolean {
  return [...ctx.deps].some((d) => /amqp|rabbit/i.test(d));
}

/** Builds the draft for a recognised amqplib queue method (everything but `assertExchange`, which has
 * its own `exchangeDraftFromSlots`) from its identity slots, already resolved (or not — `undefined` for
 * an argument this adapter could not read at all, e.g. a runtime variable). `undefined` when a required
 * slot is missing: never guesses, whether the call is direct or through a wrapper. `handlerArg` (consume
 * only): the argument index, at the call site this draft's `at` describes, holding the message handler —
 * works regardless of the wrapper's own method name (review round 1, critical 1). */
function draftFromMethod(
  method: Exclude<QueueWrapperMethod, "assertExchange">, slots: Array<QueueResolved | undefined>, at: Loc, handlerArg?: number,
): QueueOpDraft | undefined {
  switch (method) {
    case "sendToQueue":
      return slots[0] ? { shape: "name", op: "publish", at, name: slots[0] } : undefined;
    case "consume":
      return slots[0] ? { shape: "name", op: "consume", at, name: slots[0], ...(handlerArg !== undefined ? { handlerArg } : {}) } : undefined;
    case "publish":
      return slots[0] && slots[1] ? { shape: "exchange-key", op: "publish", at, exchange: slots[0], routingKey: slots[1] } : undefined;
    case "bindQueue":
      return slots[0] && slots[1] && slots[2]
        ? { shape: "bind", op: "bind", at, name: slots[0], exchange: slots[1], routingKey: slots[2] }
        : undefined;
    default:
      return undefined;
  }
}

/** `assertExchange(name, type)`'s draft (review round 1, item 8): `undefined` when either argument could
 * not be read at all. */
function exchangeDraftFromSlots(slots: Array<QueueResolved | undefined>, at: Loc): ExchangeOpDraft | undefined {
  return slots[0] && slots[1] ? { at, name: slots[0], type: slots[1] } : undefined;
}

/** A `QueueOpDraft` into its final `QueueOp` — the fanout/combine rule for an exchange publish ("Plan 1
 * encoding": `exchange:key`, or whichever of the two is non-empty) lives here, once, for both the
 * immediate (same-file) resolution and the deferred (one-import-hop) resolution in `finalizeEndpoints`.
 * `undefined` when `lookupPending` cannot settle every pending slot: never guesses. */
export function resolveQueueOpDraft(draft: QueueOpDraft, lookupPending: (p: PendingLiteral) => string | undefined): QueueOp | undefined {
  const lit = (r?: QueueResolved): string | undefined => (!r ? undefined : "literal" in r ? r.literal : lookupPending(r.pending));
  if (draft.shape === "name") {
    const name = lit(draft.name);
    return name ? { queue: name, op: draft.op, at: draft.at, ...(draft.handlerArg !== undefined ? { handlerArg: draft.handlerArg } : {}) } : undefined;
  }
  const exchange = lit(draft.exchange);
  const routingKey = lit(draft.routingKey);
  if (draft.shape === "exchange-key") {
    if (exchange === undefined || routingKey === undefined) return undefined;
    const queue = exchange && routingKey ? `${exchange}:${routingKey}` : exchange || routingKey;
    return queue ? { queue, op: "publish", exchange, routingKey, at: draft.at } : undefined;
  }
  // "bind"
  const name = lit(draft.name);
  if (name === undefined || exchange === undefined || routingKey === undefined) return undefined;
  return { queue: name, op: "bind", exchange, routingKey, at: draft.at };
}

/** An `ExchangeOpDraft` into its final `ExchangeDef` (review round 1, item 8); `undefined` when either
 * value cannot be settled, or the resolved type is not one of amqplib's four kinds (a typo, a dynamic
 * value, ...) — never guessed. */
export function resolveExchangeOpDraft(draft: ExchangeOpDraft, lookupPending: (p: PendingLiteral) => string | undefined): ExchangeDef | undefined {
  const lit = (r: QueueResolved): string | undefined => ("literal" in r ? r.literal : lookupPending(r.pending));
  const name = lit(draft.name);
  const type = lit(draft.type);
  if (name === undefined || type === undefined || !EXCHANGE_TYPES.has(type as ExchangeType)) return undefined;
  return { name, type: type as ExchangeType, at: draft.at };
}

/** Every op a resolved wrapper call produces — mixed, since one call site can both assert an exchange
 * and consume a queue (review round 1, item 7). */
export type ResolvedWrapperOp = { kind: "queue"; op: QueueOp } | { kind: "exchange"; def: ExchangeDef };

/** v0.6 Task B review round 1: the counterpart to `resolveQueueOpDraft`/`resolveExchangeOpDraft` for a
 * `QueuePendingWrapperCall` — once `finalizeEndpoints` has followed the import to find `wrapper` (or
 * found nothing: `undefined`, and this call was never a queue wrapper at all), substitutes the call's own
 * already-resolved arguments into each of the wrapper's ops and resolves every result exactly like any
 * other draft (so an argument that was itself one import hop away, e.g. `Queues.ORDER_CREATED` from a
 * third file, still resolves through `lookupPending`). Falls back to `call.fallbackDirect` (review round
 * 2, critical 1) — the direct-amqplib reading of this same call site — only when no wrapper was found at
 * all (the import turned out to be a plain re-exported channel value, not a real wrapper). A wrapper that
 * WAS found but whose own ops don't resolve (review round 3: e.g. one of its baked-in slots is an
 * unresolvable env lookup, `this.channel.publish(EXCHANGE_FROM_ENV, routingKey, …)`) never falls back —
 * that would invent a reading from the raw argument shape for a call this adapter already knows is a real
 * wrapper call; it must record nothing instead. */
export function resolveQueueWrapperCall(
  call: QueuePendingWrapperCall, wrapper: QueueWrapper | undefined, lookupPending: (p: PendingLiteral) => string | undefined,
): ResolvedWrapperOp[] {
  const out: ResolvedWrapperOp[] = [];
  for (const op of wrapper?.ops ?? []) {
    const slots = op.slots.map((slot): QueueResolved | undefined => {
      if (slot.literal !== undefined) return { literal: slot.literal };
      if (slot.paramIndex === undefined) return undefined;
      const arg = call.args[slot.paramIndex];
      return arg ?? (slot.fallbackLiteral !== undefined ? { literal: slot.fallbackLiteral } : undefined);
    });
    if (op.methodName === "assertExchange") {
      const draft = exchangeDraftFromSlots(slots, call.at);
      const resolved = draft && resolveExchangeOpDraft(draft, lookupPending);
      if (resolved) out.push({ kind: "exchange", def: resolved });
    } else {
      const draft = draftFromMethod(op.methodName, slots, call.at, op.handlerParamIndex);
      const resolved = draft && resolveQueueOpDraft(draft, lookupPending);
      if (resolved) out.push({ kind: "queue", op: resolved });
    }
  }
  // review round 3: the fallback is only for when no wrapper was found at all (an import that turned out
  // to be a plain re-exported channel value, not a real wrapper) — a wrapper that WAS found but whose own
  // ops don't resolve (e.g. one of its baked-in slots is an unresolvable env lookup) must record nothing,
  // never invent a reading from the raw argument shape instead.
  if (wrapper !== undefined || !call.fallbackDirect) return out;
  if (call.fallbackDirect.kind === "exchange") {
    const resolved = resolveExchangeOpDraft(call.fallbackDirect.draft, lookupPending);
    return resolved ? [{ kind: "exchange", def: resolved }] : [];
  }
  const resolved = resolveQueueOpDraft(call.fallbackDirect.draft, lookupPending);
  return resolved ? [{ kind: "queue", op: resolved }] : [];
}

// ---------------------------------------------------------------------------------------------------
// Literal resolution: a queue/exchange/routing-key/exchange-type name that is a string literal, a
// top-level `const`, a member of a top-level enum / `as const` object, or a class's static member — in
// this file, or (for the object/enum/class member shape, and a bare re-exported const) one import hop
// away. A bare identifier or a property-access base that is shadowed by a closer parameter/local
// declaration is never resolved this way (review round 1, item 2): it is either the wrapper's own
// parameter (handled separately, by `discoverWrappers`' own forwarding detection) or a genuinely unknown
// local value — either way, guessing the top-level name of the same spelling would be wrong.
// ---------------------------------------------------------------------------------------------------

export function memberKeyText(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

export function hasExportModifier(stmt: ts.Statement): boolean {
  return !!(ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

export function hasDefaultModifier(stmt: ts.Statement): boolean {
  return !!(ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
}

/** Strips `as const` (and parens) off an initializer, so `{ A: "a" } as const` reads the same as `{ A: "a" }`. */
export function unwrapAsConst(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** Every top-level named literal map in `sf`: an `as const`/plain object literal, a string enum, or a
 * class's static members with a string-literal initializer — keyed by its own declared name, with
 * whether it is exported (for `detectQueueLiteralExports`, the one-import-hop side). */
function namedLiteralMaps(sf: ts.SourceFile): Map<string, { members: Map<string, string>; exported: boolean }> {
  const out = new Map<string, { members: Map<string, string>; exported: boolean }>();
  for (const stmt of sf.statements) {
    const exported = hasExportModifier(stmt);
    if (ts.isVariableStatement(stmt) && (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = unwrapAsConst(d.initializer);
        if (!ts.isObjectLiteralExpression(init)) continue;
        const members = new Map<string, string>();
        for (const p of init.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const key = memberKeyText(p.name);
          const v = stringValue(p.initializer);
          if (key !== undefined && v !== undefined) members.set(key, v);
        }
        if (members.size > 0) out.set(d.name.text, { members, exported });
      }
    } else if (ts.isEnumDeclaration(stmt)) {
      const members = new Map<string, string>();
      for (const m of stmt.members) {
        const key = memberKeyText(m.name);
        const v = m.initializer && stringValue(m.initializer);
        if (key !== undefined && v !== undefined) members.set(key, v);
      }
      if (members.size > 0) out.set(stmt.name.text, { members, exported });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const members = new Map<string, string>();
      for (const member of stmt.members) {
        if (!ts.isPropertyDeclaration(member)) continue;
        const isStatic = ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
        if (!isStatic) continue;
        const key = memberKeyText(member.name);
        const v = member.initializer && stringValue(member.initializer);
        if (key !== undefined && v !== undefined) members.set(key, v);
      }
      if (members.size > 0) out.set(stmt.name.text, { members, exported });
    }
  }
  return out;
}

/** Every top-level `const NAME = "literal"` in `sf` (a bare string, not an object/enum member). */
function topLevelStringConsts(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || (stmt.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const v = stringValue(d.initializer);
      if (v !== undefined) out.set(d.name.text, v);
    }
  }
  return out;
}

/** This file's own exported literal maps, for `finalizeEndpoints` to resolve another file's one-import-hop
 * `PendingLiteral`s against. A bare exported `const NAME = "literal"` (review round 1, item 10) is carried
 * too, under the reserved member key `""` (a `PendingLiteral` with no `member` reads that key). Gated
 * behind an amqplib/amqp-connection-manager dependency (review round 1, item 5): a repo that never touches
 * RabbitMQ never pays for this scan. */
export function detectQueueLiteralExports(file: ParsedFile, ctx: AdapterContext): QueueLiteralExport[] {
  if (!file.sf || !hasAmqpDependency(ctx)) return [];
  const sf = file.sf;
  const out: QueueLiteralExport[] = [];
  for (const [name, entry] of namedLiteralMaps(sf)) {
    if (entry.exported) out.push({ file: file.rel, name, members: Object.fromEntries(entry.members) });
  }
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || !hasExportModifier(stmt) || (stmt.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const v = stringValue(d.initializer);
      if (v !== undefined) out.push({ file: file.rel, name: d.name.text, members: { "": v } });
    }
  }
  return out;
}

interface FileScope {
  consts: Map<string, string>;
  literalMaps: Map<string, Map<string, string>>;
  imports: Map<string, { from: string; name: string }>;
}

function buildScope(sf: ts.SourceFile): FileScope {
  const literalMaps = new Map<string, Map<string, string>>();
  for (const [name, entry] of namedLiteralMaps(sf)) literalMaps.set(name, entry.members);
  return { consts: topLevelStringConsts(sf), literalMaps, imports: importedBindings(sf) };
}

/** A queue/exchange/routing-key/exchange-type argument expression, resolved: a string literal; a bare
 * identifier naming a top-level const in this file, or (not locally shadowed) an imported bare const,
 * deferred one hop away; `Obj.Member` where `Obj` is a local literal map (resolved now) or an imported
 * binding (deferred — a `PendingLiteral`, resolved one hop away in `finalizeEndpoints`). `undefined` for
 * anything else (a runtime variable, a call result, a shadowed reference, ...): never guessed. */
function resolveArgExpr(expr: ts.Expression | undefined, scope: FileScope): QueueResolved | undefined {
  if (!expr) return undefined;
  const direct = stringValue(expr);
  if (direct !== undefined) return { literal: direct };
  if (ts.isIdentifier(expr)) {
    if (shadowed(expr, expr.text)) return undefined;
    const v = scope.consts.get(expr.text);
    if (v !== undefined) return { literal: v };
    const imp = scope.imports.get(expr.text);
    return imp ? { pending: { from: imp.from, importedName: imp.name } } : undefined;
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    if (shadowed(expr.expression, expr.expression.text)) return undefined;
    const objName = expr.expression.text;
    const member = expr.name.text;
    const local = scope.literalMaps.get(objName);
    if (local) {
      const v = local.get(member);
      return v !== undefined ? { literal: v } : undefined;
    }
    const imp = scope.imports.get(objName);
    return imp ? { pending: { from: imp.from, importedName: imp.name, member } } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// amqplib channel provenance (review round 1, item 3): a wrapper is only discovered when its own inner
// call's receiver has real evidence of being an amqplib channel, not just a name that happens to match.
// ---------------------------------------------------------------------------------------------------

const AMQP_CHANNEL_TYPE_RE = /\b(Channel|ConfirmChannel|ChannelWrapper)\b/;

/** `<anything>.createChannel(...)` / `<anything>.createConfirmChannel(...)` (amqplib's connection, or
 * amqp-connection-manager's own connection manager, whose `createChannel` returns a `ChannelWrapper`). */
function isChannelCreationCall(expr: ts.Expression): boolean {
  let e = expr;
  while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) &&
    (e.expression.name.text === "createChannel" || e.expression.name.text === "createConfirmChannel");
}

type ChannelEvidence =
  | { kind: "none" | "channel-type" | "created" | "new" }
  | { kind: "other-type"; typeText: string };

/** A type annotation that carries no real information either way (TypeScript's own escape hatches) — the
 * only "other-type" a STRONG receiver name is still trusted through (review round 2, item 4): real DI
 * code commonly injects a channel typed this loosely, but a REAL, specific, non-matching type
 * (`Ably.RealtimeChannel`) is honest evidence the receiver is something else entirely, even for "channel". */
function isUninformativeType(text: string): boolean {
  return text === "any" || text === "unknown";
}

function hasAccessibilityModifier(p: ts.ParameterDeclaration): boolean {
  return !!ts.getModifiers(p)?.some((m) =>
    m.kind === ts.SyntaxKind.PublicKeyword || m.kind === ts.SyntaxKind.PrivateKeyword ||
    m.kind === ts.SyntaxKind.ProtectedKeyword || m.kind === ts.SyntaxKind.ReadonlyKeyword);
}

/** Every top-level-style call/assignment inside `root`'s body that is not itself the root (a nested
 * function/arrow's own body is a different scope's concern), visited without descending into one. */
function visitOwnScope(root: ts.Node, visit: (n: ts.Node) => void): void {
  const go = (n: ts.Node): void => {
    if (n !== root && ts.isFunctionLike(n)) return;
    visit(n);
    n.forEachChild(go);
  };
  go(root);
}

/** Loose evidence for whether `this.<name>` (within class `cls`) is an amqplib channel: (1) a type
 * annotation on the property/constructor-param-property mentioning Channel/ConfirmChannel/ChannelWrapper;
 * (2) any `this.<name> = <expr>` assignment anywhere in the class whose right side is a
 * `.createChannel()`/`.createConfirmChannel()` call; (3) `new X(...)` assigned to it anywhere (amqplib
 * never constructs a Channel via `new`); (4) some OTHER explicit, non-matching type annotation with
 * neither (2) nor (3); (5) nothing at all. */
function classFieldChannelEvidence(cls: ts.ClassLikeDeclaration, name: string): ChannelEvidence {
  let typeText: string | undefined;
  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member) && memberKeyText(member.name) === name) {
      typeText = member.type?.getText() ?? typeText;
      if (member.initializer) {
        if (isChannelCreationCall(member.initializer)) return { kind: "created" };
        if (ts.isNewExpression(member.initializer)) return { kind: "new" };
      }
    }
    if (ts.isConstructorDeclaration(member)) {
      for (const p of member.parameters) {
        if (hasAccessibilityModifier(p) && ts.isIdentifier(p.name) && p.name.text === name) typeText = p.type?.getText() ?? typeText;
      }
    }
  }
  if (typeText !== undefined && AMQP_CHANNEL_TYPE_RE.test(typeText)) return { kind: "channel-type" };
  let sawCreate = false;
  let sawNew = false;
  visitOwnScope(cls, (n) => {
    if (
      ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword && n.left.name.text === name
    ) {
      if (isChannelCreationCall(n.right)) sawCreate = true;
      else if (ts.isNewExpression(n.right)) sawNew = true;
    }
  });
  if (sawCreate) return { kind: "created" };
  if (sawNew) return { kind: "new" };
  return typeText !== undefined ? { kind: "other-type", typeText } : { kind: "none" };
}

/** Same as `classFieldChannelEvidence`, for a bare local variable/parameter `name` within `fn`. */
function localChannelEvidence(fn: ts.FunctionLikeDeclaration, name: string): ChannelEvidence {
  let typeText: string | undefined;
  for (const p of fn.parameters) if (ts.isIdentifier(p.name) && p.name.text === name) typeText = p.type?.getText();
  let sawCreate = false;
  let sawNew = false;
  if (fn.body) {
    visitOwnScope(fn.body, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
        typeText = n.type?.getText() ?? typeText;
        if (n.initializer) {
          if (isChannelCreationCall(n.initializer)) sawCreate = true;
          else if (ts.isNewExpression(n.initializer)) sawNew = true;
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === name) {
        if (isChannelCreationCall(n.right)) sawCreate = true;
        else if (ts.isNewExpression(n.right)) sawNew = true;
      }
    });
  }
  if (typeText !== undefined && AMQP_CHANNEL_TYPE_RE.test(typeText)) return { kind: "channel-type" };
  if (sawCreate) return { kind: "created" };
  if (sawNew) return { kind: "new" };
  return typeText !== undefined ? { kind: "other-type", typeText } : { kind: "none" };
}

/** Is `expr` (a wrapper candidate's own inner-call receiver) really an amqplib channel? The receiver's
 * name must at least loosely match (`RECEIVER_RE`, unchanged). Beyond that (review round 2, item 4 —
 * tightened from round 1): `new X(...)` evidence always disqualifies it (amqplib never constructs a
 * Channel that way — this is what rules out `publisher = new Redis()`), and a real Channel-family type or
 * a `createChannel()`/`createConfirmChannel()` assignment always confirms it, regardless of name. Short of
 * that:
 * - an AMBIGUOUS name (`WEAK_RECEIVER_RE`: "queue", "mq", "publisher", "consumer", "broker" — a non-amqp
 *   job queue/pubsub can just as easily use the same words) now needs that positive evidence outright;
 *   "none" (no type, no traceable assignment — `private publisher = makeRedis()`, `redis.duplicate()`)
 *   or any other type no longer passes it on the name alone.
 * - an UNAMBIGUOUS name (`STRONG_RECEIVER_RE`: "channel", "amqp", "rabbit") is still trusted with no
 *   evidence either way, and through a loose `: any`/`: unknown` annotation (real DI code very often
 *   injects the channel that loosely) — but a REAL, specific, non-matching type (`Ably.RealtimeChannel`)
 *   disqualifies it too, same as a weak name; only TypeScript's own information-free escape hatches are
 *   forgiven.
 * Recall trade-off: an injected receiver with a genuinely generic field/parameter name (not matching
 * `RECEIVER_RE` at all — picked at the very first line of this function, unchanged since before this
 * round) is never found, wrapper or not; this adapter only ever follows a wrapper whose receiver still
 * looks queue-like by name. */
export function isAmqpReceiver(fn: ts.FunctionLikeDeclaration, cls: ts.ClassLikeDeclaration | undefined, expr: ts.Expression): boolean {
  const name = lastName(expr);
  if (!RECEIVER_RE.test(name)) return false;
  const strong = STRONG_RECEIVER_RE.test(name);
  let evidence: ChannelEvidence = { kind: "none" };
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    if (cls) evidence = classFieldChannelEvidence(cls, expr.name.text);
  } else if (ts.isIdentifier(expr)) {
    evidence = localChannelEvidence(fn, expr.text);
  }
  if (evidence.kind === "new") return false;
  if (evidence.kind === "channel-type" || evidence.kind === "created") return true;
  if (!strong) return false;
  if (evidence.kind === "other-type") return isUninformativeType(evidence.typeText);
  return true; // strong name, "none": no evidence either way — trust the name.
}

// ---------------------------------------------------------------------------------------------------
// Wrapper discovery: a top-level function/const-arrow or a class method whose body makes one or more
// recognised amqplib calls (review round 1, item 7 — several in the same body, e.g. assertExchange +
// bindQueue + consume, each becomes its own op), with each identity argument either a literal baked into
// the wrapper itself or one of the wrapper's own parameters, forwarded as-is (never a reassigned
// parameter — review round 1, minor item).
// ---------------------------------------------------------------------------------------------------

/** Every call in `fn`'s body (anywhere, but never descending into a nested function/arrow — a callback
 * registered inside the wrapper is a different scope's concern) to an `isAmqpReceiver`-validated
 * receiver's amqplib method. */
function findAmqpCalls(fn: ts.FunctionLikeDeclaration, cls: ts.ClassLikeDeclaration | undefined): Array<{ call: ts.CallExpression; methodName: QueueWrapperMethod }> {
  const out: Array<{ call: ts.CallExpression; methodName: QueueWrapperMethod }> = [];
  if (!fn.body) return out;
  visitOwnScope(fn.body, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const methodName = n.expression.name.text;
    if (isAmqpMethod(methodName) && isAmqpReceiver(fn, cls, n.expression.expression)) out.push({ call: n, methodName });
  });
  return out;
}

/** Every top-level `function NAME(...) {}` / `const NAME = (...) => {}` in `sf`, in source order. */
function topLevelFunctions(sf: ts.SourceFile): Array<{ name: string; fn: ts.FunctionLikeDeclaration }> {
  const out: Array<{ name: string; fn: ts.FunctionLikeDeclaration }> = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) out.push({ name: stmt.name.text, fn: stmt });
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          out.push({ name: d.name.text, fn: d.initializer });
        }
      }
    }
  }
  return out;
}

/** Every wrapper in `sf`, keyed by how it is called from outside: a bare name for a top-level
 * function/const-arrow, `ClassName.methodName` for a class method (static or instance — purely
 * name-based, like the rest of this codebase's call matching). `scope` resolves each slot's literal
 * (including a parameter's own default value) in this same file. */
function discoverWrappers(sf: ts.SourceFile, scope: FileScope): Map<string, QueueWrapper> {
  const out = new Map<string, QueueWrapper>();
  const consider = (key: string, fn: ts.FunctionLikeDeclaration, cls: ts.ClassLikeDeclaration | undefined): void => {
    if (out.has(key) || !fn.parameters.every((p) => ts.isIdentifier(p.name))) return;
    const calls = findAmqpCalls(fn, cls);
    if (calls.length === 0) return;
    const paramNames = fn.parameters.map((p) => (p.name as ts.Identifier).text);
    const ops: QueueWrapperOp[] = [];
    for (const { call, methodName } of calls) {
      const slots: QueueWrapperSlot[] = [];
      for (let i = 0; i < AMQP_METHOD_ARGC[methodName]; i++) {
        const arg = call.arguments[i];
        const lit = arg && stringValue(arg);
        if (lit !== undefined) {
          slots.push({ literal: lit });
          continue;
        }
        const idx = arg && ts.isIdentifier(arg) ? paramNames.indexOf(arg.text) : -1;
        if (idx < 0 || isMutated(fn, paramNames[idx]!)) {
          slots.push({});
          continue;
        }
        const param = fn.parameters[idx]!;
        const fallback = param.initializer && resolveArgExpr(param.initializer, scope);
        slots.push({ paramIndex: idx, ...(fallback && "literal" in fallback ? { fallbackLiteral: fallback.literal } : {}) });
      }
      // review round 1: only a genuinely parameterised op is registered as a *wrapper* — one whose every
      // identity slot is already a literal is a complete, self-describing op on its own, already found
      // by the direct path inside its own body; registering it too would double-count every caller.
      if (!slots.some((s) => s.paramIndex !== undefined)) continue;
      let handlerParamIndex: number | undefined;
      if (methodName === "consume") {
        const handlerArg = call.arguments[1];
        const idx = handlerArg && ts.isIdentifier(handlerArg) ? paramNames.indexOf(handlerArg.text) : -1;
        if (idx >= 0 && !isMutated(fn, paramNames[idx]!)) handlerParamIndex = idx;
      }
      ops.push({ methodName, slots, ...(handlerParamIndex !== undefined ? { handlerParamIndex } : {}) });
    }
    if (ops.length > 0) out.set(key, { ops });
  };
  for (const { name, fn } of topLevelFunctions(sf)) consider(name, fn, undefined);
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    for (const member of stmt.members) {
      if (!ts.isMethodDeclaration(member) || !member.body) continue;
      const methodName = memberKeyText(member.name);
      if (methodName !== undefined) consider(`${stmt.name.text}.${methodName}`, member as ts.FunctionLikeDeclaration, stmt);
    }
  }
  return out;
}

function enclosingClassNode(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) if (ts.isClassLike(cur)) return cur;
  return undefined;
}

function enclosingClassName(node: ts.Node): string | undefined {
  const cls = enclosingClassNode(node);
  return cls ? className(cls) : undefined;
}

/** The nearest enclosing `const <name> = new <ClassName>(...)` in scope at `node` — climbing through
 * blocks/functions up to the source file, nearest first (review round 1, minor: scoped, not a single
 * flat whole-file map, so two different functions can each declare their own same-named instance of a
 * different class without one shadowing the other). `undefined` when `name` is a parameter instead (a
 * plain forwarded value, never an instance) or there is no such declaration in scope. */
function instanceClassAt(node: ts.Node, name: string): string | undefined {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur) && cur.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return undefined;
    if (ts.isBlock(cur) || ts.isSourceFile(cur)) {
      for (const stmt of cur.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) {
            return d.initializer && ts.isNewExpression(d.initializer) && ts.isIdentifier(d.initializer.expression)
              ? d.initializer.expression.text : undefined;
          }
        }
      }
    }
  }
  return undefined;
}

/** The last segment of a (possibly qualified) type annotation's text: `QueueService` -> "QueueService",
 * `amqplib.Channel` -> "Channel". */
function lastTypeSegment(text: string): string {
  const parts = text.trim().split(".");
  return parts[parts.length - 1]!;
}

/** The type name of `cls`'s own field `name` — a constructor parameter property
 * (`constructor(private readonly queueService: QueueService) {}`) or a plain property declaration
 * (`private queueService: QueueService;`) — for resolving a constructor-injected `this.field.method(...)`
 * call to the wrapper class it was typed as (review round 1, item 6). */
function fieldTypeNameAt(cls: ts.ClassLikeDeclaration, name: string): string | undefined {
  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member) && memberKeyText(member.name) === name && member.type) return lastTypeSegment(member.type.getText());
    if (ts.isConstructorDeclaration(member)) {
      for (const p of member.parameters) {
        if (hasAccessibilityModifier(p) && ts.isIdentifier(p.name) && p.name.text === name && p.type) return lastTypeSegment(p.type.getText());
      }
    }
  }
  return undefined;
}

type ReceiverRef =
  | { kind: "local"; key: string }
  | { kind: "import"; from: string; importedName: string; method?: string };

/** The wrapper `node` might be calling, resolved as far as this file alone can tell: a bare name
 * (`publishEvent(...)`), `Identifier.method(...)` (`QueueService.publish(...)` on the class itself, or
 * `queueService.publish(...)` on an instance — local, scoped, or an imported singleton/class),
 * `this.method(...)` (always local — `this` never crosses files), or `this.field.method(...)` where
 * `field`'s own type annotation names the wrapper class (constructor-injected DI, local or imported).
 * `{kind:"local"}` when it is a wrapper already discovered in this file; `{kind:"import"}` when it is
 * bound to an import this file cannot itself resolve (never guessed which import actually holds it —
 * `finalizeEndpoints` follows it); `undefined` when the receiver is not identifiable as any such
 * reference at all (almost always the raw amqplib channel itself, handled by the direct path instead). */
function receiverRef(node: ts.CallExpression, wrappers: Map<string, QueueWrapper>, scope: FileScope): ReceiverRef | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    if (wrappers.has(callee.text)) return { kind: "local", key: callee.text };
    const imp = scope.imports.get(callee.text);
    return imp ? { kind: "import", from: imp.from, importedName: imp.name } : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  const recv = callee.expression;
  if (recv.kind === ts.SyntaxKind.ThisKeyword) {
    const cls = enclosingClassName(node);
    return cls !== undefined && wrappers.has(`${cls}.${method}`) ? { kind: "local", key: `${cls}.${method}` } : undefined;
  }
  let name: string | undefined;
  let nameLooksAmqp: boolean;
  if (ts.isIdentifier(recv)) {
    name = instanceClassAt(node, recv.text) ?? recv.text;
    // review round 1, item 5: a receiver (or its resolved class) with no amqp-ish name at all is never
    // worth an import lookup on a repo of any size — virtually every property-access call on an imported
    // binding would otherwise become a speculative, almost-always-wrong pending draft (measured: tens of
    // thousands on this very package). A *local* wrapper match (checked first, just below) is already
    // precise and needs no such gate.
    nameLooksAmqp = RECEIVER_RE.test(recv.text) || RECEIVER_RE.test(name);
  } else if (ts.isPropertyAccessExpression(recv) && recv.expression.kind === ts.SyntaxKind.ThisKeyword && RECEIVER_RE.test(recv.name.text)) {
    // A field reference gets the same pre-filter, checked here (on the field's own name) rather than
    // after resolving its type: a constructor commonly injects many unrelated services, and resolving
    // every single field's type annotation just to discard it would be needless work too.
    const cls = enclosingClassNode(node);
    name = cls ? fieldTypeNameAt(cls, recv.name.text) : undefined;
    nameLooksAmqp = true;
  } else {
    return undefined;
  }
  if (name === undefined) return undefined;
  if (wrappers.has(`${name}.${method}`)) return { kind: "local", key: `${name}.${method}` };
  if (!nameLooksAmqp) return undefined;
  const imp = scope.imports.get(name);
  return imp ? { kind: "import", from: imp.from, importedName: imp.name, method } : undefined;
}

function slotValue(slot: QueueWrapperSlot, node: ts.CallExpression, scope: FileScope): QueueResolved | undefined {
  if (slot.literal !== undefined) return { literal: slot.literal };
  if (slot.paramIndex === undefined) return undefined;
  const arg = node.arguments[slot.paramIndex];
  if (arg === undefined) return slot.fallbackLiteral !== undefined ? { literal: slot.fallbackLiteral } : undefined;
  return resolveArgExpr(arg, scope) ?? (slot.fallbackLiteral !== undefined && ts.isIdentifier(arg) && arg.text === "undefined"
    ? { literal: slot.fallbackLiteral } : undefined);
}

/** A package specifier a `QueuePendingWrapperCall` is worth creating for at all (review round 1, item 5;
 * round 2, minor — Node builtins): relative (`./x`), a Node subpath import (`#x`), an absolute
 * specifier, or anything not already a known dependency of this file's own package (and not a `node:`
 * built-in, which is never a dependency either, so without this it would be wrongly treated as a repo
 * alias) — the only way an alias (`@/lib/x`) is told apart from a real scoped package (`@nestjs/common`)
 * without reading tsconfig paths here. A bare package import never resolves to a repo file anyway, so
 * skipping it outright avoids the wasted draft. */
export function isLikelyRepoImport(spec: string, deps: Set<string>): boolean {
  if (spec.startsWith("node:")) return false;
  if (spec.startsWith(".") || spec.startsWith("#") || spec.startsWith("/")) return true;
  const parts = spec.split("/");
  const packageName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  if (BUILTIN_MODULES.has(packageName)) return false;
  return !deps.has(packageName);
}

/** The direct-amqplib-call reading of `node` (the pre-0.6 behaviour): `undefined` when `methodName` is
 * not a recognised amqplib method, or when its identity arguments do not resolve. Shared by the direct
 * path itself and a pending wrapper call's `fallbackDirect` (review round 2, critical 1). */
function directOpAt(node: ts.CallExpression, methodName: string, scope: FileScope, at: Loc): DirectOpDraft | undefined {
  if (!isAmqpMethod(methodName)) return undefined;
  const slots = Array.from({ length: AMQP_METHOD_ARGC[methodName] }, (_, i) => resolveArgExpr(node.arguments[i], scope));
  if (methodName === "assertExchange") {
    const draft = exchangeDraftFromSlots(slots, at);
    return draft ? { kind: "exchange", draft } : undefined;
  }
  const draft = draftFromMethod(methodName, slots, at, methodName === "consume" ? 1 : undefined);
  return draft ? { kind: "queue", draft } : undefined;
}

/** Every amqplib op this file produces: resolved outright, needing one import hop for a literal name
 * (`drafts`/`exchangeDrafts`), or needing one import hop to even know which wrapper is being called
 * (`wrapperCalls`). Gated behind an amqplib/amqp-connection-manager dependency (review round 1, item 5). */
export function collectQueueOps(file: ParsedFile, ctx: AdapterContext): {
  resolved: QueueOp[]; drafts: QueueOpDraft[]; wrapperCalls: QueuePendingWrapperCall[];
  exchanges: ExchangeDef[]; exchangeDrafts: ExchangeOpDraft[];
} {
  const resolved: QueueOp[] = [];
  const drafts: QueueOpDraft[] = [];
  const wrapperCalls: QueuePendingWrapperCall[] = [];
  const exchanges: ExchangeDef[] = [];
  const exchangeDrafts: ExchangeOpDraft[] = [];
  if (!file.sf || !hasAmqpDependency(ctx)) return { resolved, drafts, wrapperCalls, exchanges, exchangeDrafts };
  const scope = buildScope(file.sf);
  const wrappers = discoverWrappers(file.sf, scope);
  const recordQueue = (draft: QueueOpDraft | undefined): boolean => {
    if (!draft) return false;
    const immediate = resolveQueueOpDraft(draft, () => undefined);
    if (immediate) resolved.push(immediate);
    else drafts.push(draft);
    return true;
  };
  const recordExchange = (draft: ExchangeOpDraft | undefined): boolean => {
    if (!draft) return false;
    const immediate = resolveExchangeOpDraft(draft, () => undefined);
    if (immediate) exchanges.push(immediate);
    else exchangeDrafts.push(draft);
    return true;
  };
  walk(file.sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const ref = receiverRef(node, wrappers, scope);
    if (ref?.kind === "local") {
      // review round 1, item 6: a locally-identified wrapper always wins over amqplib's own argument
      // shape, even when the method name happens to coincide (`this.queueService.publish(q, msg)`
      // wrapping `sendToQueue` must never be misread as a 2-arg exchange publish).
      const at: Loc = { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) };
      for (const op of wrappers.get(ref.key)!.ops) {
        const slots = op.slots.map((slot) => slotValue(slot, node, scope));
        if (op.methodName === "assertExchange") recordExchange(exchangeDraftFromSlots(slots, at));
        else recordQueue(draftFromMethod(op.methodName, slots, at, op.handlerParamIndex));
      }
      return;
    }
    if (ref?.kind === "import" && isLikelyRepoImport(ref.from, ctx.deps)) {
      // review round 2, critical 1: the imported name a repo-relative call targets is very often not a
      // wrapper at all but a plain re-exported channel value (`export const channel = await
      // conn.createChannel();`) — this file cannot tell the two apart ahead of time, so it carries a
      // direct-call fallback alongside the pending wrapper call, for `finalizeEndpoints` to use only when
      // no real wrapper resolves at the other end. (A *bare package* import, e.g. amqplib's own `Channel`
      // value import used purely for a type annotation, is deliberately NOT handled here at all — it
      // falls through to the direct path below, unchanged from pre-0.6, since it can never be a repo
      // wrapper in the first place.)
      const at: Loc = { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) };
      const args = node.arguments.slice(0, MAX_WRAPPER_ARGS).map((a) => resolveArgExpr(a, scope));
      const fallbackDirect = ref.method !== undefined ? directOpAt(node, ref.method, scope, at) : undefined;
      // review round 1, item 5: with every argument unresolvable AND no direct fallback, no wrapper this
      // could possibly name would ever produce anything, so there is nothing worth deferring at all.
      if (args.some((a) => a !== undefined) || fallbackDirect) {
        wrapperCalls.push({
          at, from: ref.from, importedName: ref.importedName, ...(ref.method !== undefined ? { method: ref.method } : {}), args,
          ...(fallbackDirect ? { fallbackDirect } : {}),
        });
      }
      return;
    }
    if (!ts.isPropertyAccessExpression(node.expression) || !RECEIVER_RE.test(lastName(node.expression.expression))) return;
    const at: Loc = { file: file.rel, line: lineOf(node), symbol: enclosingSymbol(node) };
    const op = directOpAt(node, node.expression.name.text, scope, at);
    if (!op) return;
    if (op.kind === "exchange") recordExchange(op.draft);
    else recordQueue(op.draft);
  });
  return { resolved, drafts, wrapperCalls, exchanges, exchangeDrafts };
}

export function detectQueues(file: ParsedFile, ctx: AdapterContext): QueueOp[] {
  return collectQueueOps(file, ctx).resolved;
}

/** This file's own top-level `const <name> = new <ClassName>(...)` instances (module scope only — the
 * only scope an export statement can itself reference), for resolving an exported singleton to its
 * wrapper class (`export const queueService = new QueueService();`, `export { queueService };`). */
function topLevelInstanceClasses(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && ts.isNewExpression(d.initializer) && ts.isIdentifier(d.initializer.expression)) {
        out.set(d.name.text, d.initializer.expression.text);
      }
    }
  }
  return out;
}

/** This file's own exported wrappers, keyed the same way `discoverWrappers` keys them, for
 * `finalizeEndpoints` to resolve another file's `queueWrapperCalls` against: a bare exported
 * function/const-arrow wrapper under its own name; a class method under `ExportedClass.method` when the
 * class itself is exported; a class method under `exportedInstanceName.method` when an exported `const x
 * = new ClassName(...)` singleton is the thing actually imported elsewhere; `default.method` for a default
 * export (`export default class X {}`, `export default new X();`, `export default x;`); and any alias a
 * later `export { x as y };` list gives a local wrapper/instance. Gated behind an amqplib/
 * amqp-connection-manager dependency (review round 1, item 5). */
export function detectQueueWrapperExports(file: ParsedFile, ctx: AdapterContext): QueueWrapperExport[] {
  if (!file.sf || !hasAmqpDependency(ctx)) return [];
  const sf = file.sf;
  const scope = buildScope(sf);
  const wrappers = discoverWrappers(sf, scope);
  if (wrappers.size === 0) return [];
  const topInstances = topLevelInstanceClasses(sf);
  const out: QueueWrapperExport[] = [];
  const emit = (exportedName: string, prefix: string): void => {
    for (const [key, w] of wrappers) {
      if (key === prefix) out.push({ file: file.rel, name: exportedName, wrapper: w });
      else if (key.startsWith(`${prefix}.`)) out.push({ file: file.rel, name: `${exportedName}${key.slice(prefix.length)}`, wrapper: w });
    }
  };
  for (const stmt of sf.statements) {
    const exported = hasExportModifier(stmt);
    const isDefault = exported && hasDefaultModifier(stmt);
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      if (exported) emit(stmt.name.text, stmt.name.text);
      if (isDefault) emit("default", stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      if (exported) emit(stmt.name.text, stmt.name.text);
      if (isDefault) emit("default", stmt.name.text);
    } else if (ts.isVariableStatement(stmt) && exported) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) emit(d.name.text, d.name.text);
        else if (ts.isNewExpression(d.initializer) && ts.isIdentifier(d.initializer.expression)) emit(d.name.text, d.initializer.expression.text);
      }
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      // `export default new QueueService();` / `export default QueueService;` / `export default queueService;`
      const expr = stmt.expression;
      if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) emit("default", expr.expression.text);
      else if (ts.isIdentifier(expr)) emit("default", topInstances.get(expr.text) ?? expr.text);
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      // `export { queueService };` / `export { queueService as qs };`
      for (const el of stmt.exportClause.elements) {
        if (el.isTypeOnly) continue;
        const local = (el.propertyName ?? el.name).text;
        emit(el.name.text, topInstances.get(local) ?? local);
      }
    }
  }
  return out;
}
