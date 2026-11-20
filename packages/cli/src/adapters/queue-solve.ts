import type { ExchangeDef, ExchangeType, Loc, QueueOp, QueueUnknown } from "../store/schemas.js";
import type { QClass, QFlowFile, QFn, QHandler, QRef, QV } from "./queue-flow.js";
import { EXCHANGE_TYPES } from "./queues.js";
import type { QueueWrapperMethod, ReExportDraft } from "./types.js";

// ---------------------------------------------------------------------------------------------------
// v0.6 queues fix: settles every file's queue-flow summary (queue-flow.ts) together.
//
// Each function's queue ops are computed once, in terms of its own parameters and `this` ("open"), by
// taking its own amqplib calls and, at every call it makes, the callee's ops with the call's arguments and
// receiver put in. An op is recorded where its names become fully known:
// - a publish: at that place (the outermost call that knows the names, as for a plain wrapper);
// - a consume / bind / assertExchange that depended on `this`: at the amqplib call itself (the subclass's own
//   consume loop is where its messages arrive), with a subclass's overriding handler as `handler`;
// - one that depended only on parameters: at the call that knows the names (a plain wrapper, unchanged).
// Every non-abstract class is also tried on its own (its fields with unknown constructor arguments): a
// consumer subclass whose names are all in `super(...)` or field overrides, or a publisher subclass nobody is
// seen calling (recorded at the subclass).
// A name that becomes unknowable (a runtime value) is recorded once, where it is lost, as a `QueueUnknown`.
// ---------------------------------------------------------------------------------------------------

export type ImportResolver = (fromRel: string, specifier: string) => string | null;

interface Inst {
  m: QueueWrapperMethod;
  slots: Array<QV | null>;
  origin: Loc;
  last: Loc;
  h?: QHandler | { k: "arg"; i: number; at: Loc };
  /** Its names depended on a receiver bound somewhere (`new Sub().x()`, an instance, a field). */
  self: boolean;
  /** The class the op's own `this` turned out to be. */
  concrete?: QRef;
  /** The class whose method holds the amqplib call. */
  owner?: QRef;
}

type Ent =
  | { kind: "class"; file: string; cls: QClass }
  | { kind: "fn"; file: string; fn: QFn }
  | { kind: "inst"; v: QV }
  | { kind: "lit"; v: string }
  | { kind: "table"; rows: Record<string, string | Record<string, string>> };

const MISSING = Symbol("missing");
const MAX_OPS_PER_FN = 64;
const MAX_VALUE_CHARS = 4000;
const BARREL_HOPS = 3;

const locKey = (l: Loc) => `${l.file}:${l.line}`;
const fnKeyOf = (l: Loc) => `${l.file}#${l.symbol}`;

function isOpen(v: QV | null): boolean {
  if (!v) return false;
  switch (v.k) {
    case "param": case "self": return true;
    case "prop": return isOpen(v.of);
    case "lookup": return isOpen(v.key);
    case "or": return isOpen(v.a) || isOpen(v.b);
    case "tpl": return v.parts.some((p) => typeof p !== "string" && isOpen(p));
    case "aq": return isOpen(v.name);
    case "obj": return (v.args ?? []).some(isOpen) || (v.chain ?? []).some((c) => c.args.some(isOpen));
    default: return false;
  }
}

function hasSelf(v: QV | null): boolean {
  if (!v) return false;
  switch (v.k) {
    case "self": return true;
    case "prop": return hasSelf(v.of);
    case "lookup": return hasSelf(v.key);
    case "or": return hasSelf(v.a) || hasSelf(v.b);
    case "tpl": return v.parts.some((p) => typeof p !== "string" && hasSelf(p));
    case "aq": return hasSelf(v.name);
    case "obj": return (v.args ?? []).some(hasSelf) || (v.chain ?? []).some((c) => c.args.some(hasSelf));
    default: return false;
  }
}

function hasParam(v: QV | null): boolean {
  if (!v) return false;
  switch (v.k) {
    case "param": return true;
    case "prop": return hasParam(v.of);
    case "lookup": return hasParam(v.key);
    case "or": return hasParam(v.a) || hasParam(v.b);
    case "tpl": return v.parts.some((p) => typeof p !== "string" && hasParam(p));
    case "aq": return hasParam(v.name);
    case "obj": return (v.args ?? []).some(hasParam) || (v.chain ?? []).some((c) => c.args.some(hasParam));
    default: return false;
  }
}

interface Env {
  /** null: the arguments are unknown (a class tried on its own). */
  args: Array<QV | null> | null;
  defaults: Array<QV | null>;
  /** "self": the call is on `this` (stays open); null: there is no receiver. */
  recv: QV | "self" | null;
}

export interface SolveResult {
  ops: QueueOp[];
  exchanges: ExchangeDef[];
  unknown: QueueUnknown[];
}

export function solveQueueFlow(files: QFlowFile[], resolveImport: ImportResolver | undefined, reExports: ReExportDraft[]): SolveResult {
  const resolveMemo = new Map<string, string | null>();
  const resolve: ImportResolver | undefined = resolveImport && ((from, spec) => {
    const key = `${from}\0${spec}`;
    if (!resolveMemo.has(key)) resolveMemo.set(key, resolveImport(from, spec));
    return resolveMemo.get(key)!;
  });
  const byFile = new Map(files.map((f) => [f.file, f]));
  const reByFile = new Map<string, ReExportDraft[]>();
  for (const re of reExports) reByFile.set(re.file, [...(reByFile.get(re.file) ?? []), re]);

  // ---- names ----------------------------------------------------------------------------------------
  const entity = (file: string, name: string): Ent | undefined => {
    const f = byFile.get(file);
    if (!f) return undefined;
    if (f.classes[name]) return { kind: "class", file, cls: f.classes[name]! };
    if (f.fns[name]) return { kind: "fn", file, fn: f.fns[name]! };
    if (f.instances[name]) return { kind: "inst", v: f.instances[name]! };
    if (f.lits[name] !== undefined) return { kind: "lit", v: f.lits[name]! };
    if (f.tables[name]) return { kind: "table", rows: f.tables[name]! };
    return undefined;
  };
  const exportMemo = new Map<string, Ent | undefined>();
  const exported = (file: string, name: string, hops: number): Ent | undefined => {
    const key = `${file}\0${name}`;
    if (exportMemo.has(key)) return exportMemo.get(key);
    exportMemo.set(key, undefined);
    let hit: Ent | undefined;
    const f = byFile.get(file);
    if (f) {
      if (name === "default" && f.defaultValue) hit = { kind: "inst", v: f.defaultValue };
      else if (f.exports[name] !== undefined) hit = entity(file, f.exports[name]!);
    }
    if (!hit && hops < BARREL_HOPS && resolve) {
      for (const re of reByFile.get(file) ?? []) {
        const next = re.kind === "all" ? (name === "default" ? undefined : name) : re.exported === name ? re.imported : undefined;
        if (next === undefined) continue;
        const target = resolve(file, re.from);
        hit = target ? exported(target, next, hops + 1) : undefined;
        if (hit) break;
      }
    }
    exportMemo.set(key, hit);
    return hit;
  };
  const deref = (ref: QRef): Ent | undefined => {
    if (ref.from === undefined) return entity(ref.file, ref.name);
    const target = resolve?.(ref.file, ref.from);
    return target ? exported(target, ref.name, 0) : undefined;
  };
  const classOf = (ref: QRef): { file: string; cls: QClass } | undefined => {
    const e = deref(ref);
    return e?.kind === "class" ? { file: e.file, cls: e.cls } : undefined;
  };
  const refOf = (c: { file: string; cls: QClass }): QRef => ({ file: c.file, name: c.cls.name });

  /** Method `m` of class `ref` or the nearest base that has it. */
  const findMethod = (ref: QRef, m: string, wantStatic: boolean, depth = 0): { id: string; file: string; fn: QFn; owner: QRef } | undefined => {
    const c = classOf(ref);
    if (!c || depth > 8) return undefined;
    const fn = byFile.get(c.file)!.fns[`${c.cls.name}.${m}`];
    if (fn && !!fn.isStatic === wantStatic) return { id: `${c.file}#${fn.key}`, file: c.file, fn, owner: refOf(c) };
    return c.cls.ext ? findMethod(c.cls.ext, m, wantStatic, depth + 1) : undefined;
  };

  // ---- values ---------------------------------------------------------------------------------------
  const tableOf = (t: QRef): Record<string, string | Record<string, string>> | undefined => {
    const e = deref(t);
    if (e?.kind === "table") return e.rows;
    if (e?.kind === "class") return byFile.get(e.file)!.tables[e.cls.name];
    return undefined;
  };

  /** An object value's class, when it really is one (a static factory that returns the class, fluent calls). */
  const asObj = (v: QV | null, depth = 0): Extract<QV, { k: "obj" }> | undefined => {
    if (!v || depth > 6) return undefined;
    if (v.k === "obj") {
      const c = classOf(v.cls);
      if (!c) return undefined;
      if (v.via !== undefined && !c.cls.singletons.includes(v.via)) return undefined;
      for (const step of v.chain ?? []) if (!fluentOf(v.cls, step.m)) return undefined;
      return v;
    }
    if (v.k === "ret") {
      const e = deref(v.fn);
      return e?.kind === "fn" && e.fn.returns ? asObj(e.fn.returns, depth + 1) : undefined;
    }
    if (v.k === "imp" && v.member === undefined) {
      const e = deref(v.ref);
      return e?.kind === "inst" ? asObj(e.v, depth + 1) : undefined;
    }
    return undefined;
  };

  const fluentOf = (ref: QRef, m: string, depth = 0): Array<{ f: string; v: QV | null }> | undefined => {
    const c = classOf(ref);
    if (!c || depth > 8) return undefined;
    return c.cls.fluent[m] ?? (c.cls.ext ? fluentOf(c.cls.ext, m, depth + 1) : undefined);
  };
  /** The fields method `m` sets (a fluent setter or a plain one), from `ref` up its bases. */
  const setsOf = (ref: QRef, m: string, depth = 0): Array<{ f: string; v: QV | null }> | undefined => {
    const c = classOf(ref);
    if (!c || depth > 8) return undefined;
    return c.cls.fluent[m] ?? c.cls.sets[m] ?? (c.cls.ext ? setsOf(c.cls.ext, m, depth + 1) : undefined);
  };

  /** `prop` built from parts, folded as far as the values allow. */
  const mkProp = (of: QV, p: string, depth: number): QV | null => {
    if (of.k === "aq") return p === "queue" ? of.name : null;
    if (of.k === "lookup" && of.p === undefined) return { ...of, p };
    if (of.k === "imp" && of.member === undefined) {
      const e = deref(of.ref);
      if (e?.kind === "inst") return mkProp(e.v, p, depth + 1);
      return { ...of, member: p };
    }
    if (of.k === "obj" || of.k === "ret") {
      const o = asObj(of);
      return o ? fieldOf(o, p, depth + 1) : null;
    }
    if (of.k === "param" || of.k === "self" || of.k === "prop") return { k: "prop", of, p };
    return null;
  };

  const sub = (v: QV | null, env: Env, depth = 0): QV | null => {
    if (!v || depth > 24) return null;
    switch (v.k) {
      case "lit": case "imp": case "ret": return v;
      case "param": {
        if (env.args === null) return null;
        return v.i < env.args.length ? env.args[v.i]! : (env.defaults[v.i] ?? null);
      }
      case "self": return env.recv === "self" ? v : env.recv;
      case "prop": {
        const of = sub(v.of, env, depth + 1);
        return of ? mkProp(of, v.p, depth + 1) : null;
      }
      case "lookup": {
        const key = sub(v.key, env, depth + 1);
        return key ? { ...v, key } : null;
      }
      case "or": {
        const a = sub(v.a, env, depth + 1);
        return a ? { k: "or", a, b: sub(v.b, env, depth + 1) } : null;
      }
      case "tpl": {
        const parts: Array<string | QV> = [];
        for (const p of v.parts) {
          if (typeof p === "string") parts.push(p);
          else {
            const s = sub(p, env, depth + 1);
            if (!s) return null;
            parts.push(s);
          }
        }
        return { k: "tpl", parts };
      }
      case "aq": {
        const name = sub(v.name, env, depth + 1);
        return name ? { k: "aq", name } : null;
      }
      case "obj": {
        const out: QV = {
          ...v,
          args: v.args === null ? null : v.args.map((a) => sub(a, env, depth + 1)),
          ...(v.chain ? { chain: v.chain.map((c) => ({ m: c.m, args: c.args.map((a) => sub(a, env, depth + 1)) })) } : {}),
        };
        return JSON.stringify(out).length > MAX_VALUE_CHARS ? null : out;
      }
    }
  };

  /** Field `f` of an instance: a fluent setter in its chain, else the class's constructor / field initialiser
   * (a subclass's own first), else an `assertQueue` reply or instance assigned later, else its declared class. */
  const fieldOf = (obj: Extract<QV, { k: "obj" }>, f: string, depth: number): QV | null => {
    if (depth > 16) return null;
    const chain = obj.chain ?? [];
    for (let i = chain.length - 1; i >= 0; i--) {
      const set = fluentOf(obj.cls, chain[i]!.m)?.find((x) => x.f === f);
      if (set) {
        const recv: QV = { ...obj, chain: chain.slice(0, i) };
        return set.v ? sub(set.v, { args: chain[i]!.args, defaults: [], recv }, depth + 1) : null;
      }
    }
    const base: QV = { ...obj, chain: [] };
    const direct = classField(obj.cls, f, obj.args, base, depth + 1);
    if (direct !== MISSING && direct !== null) return direct;
    const later = laterOf(obj.cls, f);
    if (later) return sub(later, { args: [], defaults: [], recv: base }, depth + 1);
    const t = typeOf(obj.cls, f);
    return t ? { k: "obj", cls: t, args: null } : null;
  };

  const classField = (ref: QRef, f: string, args: Array<QV | null> | null, recv: QV, depth: number): QV | null | typeof MISSING => {
    const c = classOf(ref);
    if (!c || depth > 24) return MISSING;
    const env: Env = { args, defaults: c.cls.ctor?.defaults ?? [], recv };
    if (c.cls.ctor) {
      // The constructor's last word on `f`: a direct assignment, or a setter it calls (`this.onQueue(X)`).
      const steps = c.cls.ctor.steps;
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i]!;
        if ("f" in step) {
          if (step.f === f) return sub(step.v, env, depth + 1);
          continue;
        }
        const set = setsOf(ref, step.m)?.find((x) => x.f === f);
        if (set) return set.v ? sub(set.v, { args: step.args.map((a) => sub(a, env, depth + 1)), defaults: [], recv }, depth + 1) : null;
      }
    }
    if (f in c.cls.fields) return sub(c.cls.fields[f]!, { args: [], defaults: [], recv }, depth + 1);
    if (!c.cls.ext) return MISSING;
    const superArgs = c.cls.ctor ? (c.cls.ctor.superArgs ?? []).map((a) => sub(a, env, depth + 1)) : args;
    return classField(c.cls.ext, f, superArgs, recv, depth + 1);
  };
  const laterOf = (ref: QRef, f: string, depth = 0): QV | undefined => {
    const c = classOf(ref);
    if (!c || depth > 8) return undefined;
    return c.cls.later[f] ?? (c.cls.ext ? laterOf(c.cls.ext, f, depth + 1) : undefined);
  };
  const typeOf = (ref: QRef, f: string, depth = 0): QRef | undefined => {
    const c = classOf(ref);
    if (!c || depth > 8) return undefined;
    return c.cls.fieldTypes[f] ?? (c.cls.ext ? typeOf(c.cls.ext, f, depth + 1) : undefined);
  };

  /** A closed value as a string; undefined when it cannot be read. */
  const str = (v: QV | null, depth = 0): string | undefined => {
    if (!v || depth > 16) return undefined;
    switch (v.k) {
      case "lit": return v.v;
      case "imp": {
        const e = deref(v.ref);
        if (v.member === undefined) return e?.kind === "lit" ? e.v : undefined;
        if (e?.kind === "inst") {
          const p = mkProp(e.v, v.member, depth + 1);
          return p ? str(p, depth + 1) : undefined;
        }
        const rows = e?.kind === "table" ? e.rows : e?.kind === "class" ? byFile.get(e.file)!.tables[e.cls.name] : undefined;
        const row = rows?.[v.member];
        return typeof row === "string" ? row : undefined;
      }
      case "tpl": {
        let out = "";
        for (const p of v.parts) {
          const s = typeof p === "string" ? p : str(p, depth + 1);
          if (s === undefined) return undefined;
          out += s;
        }
        return out;
      }
      case "or": {
        const a = str(v.a, depth + 1);
        if (a === undefined) return undefined;
        return a !== "" ? a : str(v.b, depth + 1);
      }
      case "lookup": {
        const key = str(v.key, depth + 1);
        const row = key !== undefined ? tableOf(v.t)?.[key] : undefined;
        if (v.p === undefined) return typeof row === "string" ? row : undefined;
        return row && typeof row === "object" ? row[v.p] : undefined;
      }
      case "prop": {
        const p = mkProp(v.of, v.p, depth + 1);
        return p && p.k !== "prop" ? str(p, depth + 1) : undefined;
      }
      default: return undefined;
    }
  };

  // ---- calls ----------------------------------------------------------------------------------------
  interface Target { id: string; file: string; fn: QFn; recv: QV | "self" | null; owner?: QRef }

  const ownClass = (file: string, fn: QFn): QRef | undefined => (fn.cls !== undefined ? { file, name: fn.cls } : undefined);

  const resolveCallee = (file: string, fn: QFn, c: QFn["calls"][number]): Target | undefined => {
    const callee = c.c;
    switch (callee.k) {
      case "fn": {
        const e = deref(callee.ref);
        return e?.kind === "fn" ? { id: `${e.file}#${e.fn.key}`, file: e.file, fn: e.fn, recv: null } : undefined;
      }
      case "this": {
        const own = ownClass(file, fn);
        const hit = own && findMethod(own, callee.m, !!fn.isStatic);
        return hit ? { ...hit, recv: fn.isStatic ? null : "self" } : undefined;
      }
      case "super": {
        const own = ownClass(file, fn);
        const ext = own && classOf(own)?.cls.ext;
        const hit = ext && findMethod(ext, callee.m, !!fn.isStatic);
        return hit ? { ...hit, recv: fn.isStatic ? null : "self" } : undefined;
      }
      case "name": {
        const e = deref(callee.ref);
        if (e?.kind === "class") {
          const hit = findMethod({ file: e.file, name: e.cls.name }, callee.m, true);
          return hit ? { ...hit, recv: null } : undefined;
        }
        if (e?.kind === "inst") {
          const o = asObj(e.v);
          const hit = o && findMethod(o.cls, callee.m, false);
          return hit ? { ...hit, recv: o } : undefined;
        }
        return undefined;
      }
      case "on": {
        let cls: QRef | undefined = callee.t;
        const recv = callee.recv;
        if (!cls) {
          const o = asObj(recv);
          if (o) cls = o.cls;
          else if (recv.k === "prop" && recv.of.k === "self" && fn.cls !== undefined) {
            // `this.<field>.m()`: the field's class, read on the function's own class.
            const own: QV = { k: "obj", cls: { file, name: fn.cls }, args: null };
            const field = fieldOf(own, recv.p, 0);
            cls = asObj(field)?.cls;
          }
        }
        const hit = cls && findMethod(cls, callee.m, false);
        return hit ? { ...hit, recv: asObj(recv) ?? recv } : undefined;
      }
    }
  };

  // ---- ops ------------------------------------------------------------------------------------------
  const memo = new Map<string, Inst[]>();
  const busy = new Set<string>();
  const called = new Set<string>();
  const ops = new Map<string, QueueOp>();
  const exchanges = new Map<string, ExchangeDef>();
  const emittedAt = new Set<string>();
  const emittedFns = new Set<string>();
  const emittedValues = new Set<string>();
  const deads: Array<{ inst: Inst; at: Loc; kind: "origin" | "call" | "class" }> = [];
  const fallbacks: Array<{ inst: Inst; values: string[]; at: Loc }> = [];

  /** The class that declares instance method `m`, from `ref` up its bases. */
  const declarerOf = (ref: QRef, m: string, depth = 0): { file: string; cls: QClass } | undefined => {
    const c = classOf(ref);
    if (!c || depth > 8) return undefined;
    if (c.cls.methods.includes(m)) return c;
    return c.cls.ext ? declarerOf(c.cls.ext, m, depth + 1) : undefined;
  };
  const handlerAt = (ref: QRef | undefined, m: string): { file: string; symbol: string } | undefined => {
    const c = ref && declarerOf(ref, m);
    return c ? { file: c.file, symbol: `${c.cls.name}.${m}` } : undefined;
  };

  /** Where an op whose names are known is recorded, and with which handler. */
  const placeOf = (inst: Inst, here: Loc): { at: Loc; handlerArg?: number; handler?: { file: string; symbol: string } } => {
    if (inst.m === "publish" || inst.m === "sendToQueue") return { at: here };
    const h = inst.h;
    if (h?.k === "arg") return { at: h.at, ...(inst.m === "consume" ? { handlerArg: h.i } : {}) };
    const at = inst.self ? inst.origin : here;
    if (inst.m !== "consume") return { at };
    const atOrigin = locKey(at) === locKey(inst.origin);
    if (h?.k === "method") {
      const handler = handlerAt(inst.concrete ?? inst.owner, h.m);
      return { at, ...(atOrigin ? { handlerArg: 1 } : {}), ...(handler ? { handler } : {}) };
    }
    if (h?.k === "inline") {
      // A base consume loop handing each message to a method the subclass overrides: that method is the handler.
      if (inst.concrete && inst.owner) {
        const overridden = new Map<string, { file: string; symbol: string }>();
        for (const m of h.calls) {
          const c = declarerOf(inst.concrete, m);
          if (c && !(c.file === inst.owner.file && c.cls.name === inst.owner.name)) {
            overridden.set(`${c.cls.name}.${m}`, { file: c.file, symbol: `${c.cls.name}.${m}` });
          }
        }
        if (overridden.size === 1) return { at, ...(atOrigin ? { handlerArg: 1 } : {}), handler: [...overridden.values()][0]! };
      }
      return atOrigin ? { at, handlerArg: 1 } : { at, handler: { file: inst.origin.file, symbol: inst.origin.symbol } };
    }
    return atOrigin ? { at, handlerArg: 1 } : { at };
  };

  const record = (inst: Inst, values: string[], here: Loc): void => {
    const place = placeOf(inst, here);
    const at = place.at;
    let op: QueueOp | undefined;
    switch (inst.m) {
      case "sendToQueue":
        if (values[0]) op = { queue: values[0], op: "publish", at };
        break;
      case "publish": {
        const [exchange, routingKey] = values as [string, string];
        const queue = exchange && routingKey ? `${exchange}:${routingKey}` : exchange || routingKey;
        if (queue) op = { queue, op: "publish", exchange, routingKey, at };
        break;
      }
      case "consume":
        if (values[0]) {
          op = {
            queue: values[0], op: "consume", at, ...(place.handlerArg !== undefined ? { handlerArg: place.handlerArg } : {}),
            ...(place.handler ? { handler: place.handler } : {}),
          };
        }
        break;
      case "bindQueue":
        if (values[0]) op = { queue: values[0], op: "bind", exchange: values[1]!, routingKey: values[2]!, at };
        break;
      case "assertExchange":
        if (values[0] && EXCHANGE_TYPES.has(values[1] as ExchangeType)) {
          const def: ExchangeDef = { name: values[0], type: values[1] as ExchangeType, at };
          exchanges.set(`${locKey(at)}\0${def.name}\0${def.type}`, def);
        }
        break;
    }
    emittedAt.add(locKey(here));
    emittedAt.add(locKey(at));
    emittedFns.add(fnKeyOf(inst.origin));
    emittedValues.add(`${locKey(inst.origin)}\0${values.join("\0")}`);
    if (op) ops.set(`${locKey(at)}\0${op.op}\0${op.queue}\0${op.exchange ?? ""}\0${op.routingKey ?? ""}\0${op.handler?.symbol ?? ""}`, op);
  };

  /** Recorded (names known), dead (a name lost), or still open (returned). `inherited`: a class tried on its own,
   * through a method it inherits. */
  const settle = (inst: Inst, here: Loc, kind: "origin" | "call" | "class", inherited = false): Inst | undefined => {
    if (inst.slots.some((s) => s === null)) {
      deads.push({ inst, at: here, kind });
      return undefined;
    }
    if (inst.slots.some(isOpen)) return kind === "class" ? undefined : inst;
    const values = inst.slots.map((s) => str(s));
    if (values.some((v) => v === undefined)) {
      deads.push({ inst, at: here, kind });
      return undefined;
    }
    if (kind === "class" && (inst.m === "publish" || inst.m === "sendToQueue") && (inherited || locKey(inst.last) === locKey(inst.origin))) {
      // A publisher subclass nobody is seen calling: recorded at the subclass, unless a caller already was.
      fallbacks.push({ inst, values: values as string[], at: here });
      return undefined;
    }
    record(inst, values as string[], kind === "class" ? inst.last : here);
    return undefined;
  };

  const effOps = (id: string, file: string, fn: QFn): Inst[] => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (busy.has(id)) return [];
    busy.add(id);
    const out: Inst[] = [];
    const loc = (line: number, sym?: string): Loc => ({ file, line, symbol: sym ?? fn.symbol });
    const owner = ownClass(file, fn);
    for (const a of fn.amqp) {
      const at = loc(a.line, a.sym);
      const inst: Inst = { m: a.m, slots: a.slots, origin: at, last: at, self: false, ...(a.h ? { h: a.h } : {}), ...(owner ? { owner } : {}) };
      const open = settle(inst, at, "origin");
      if (open && out.length < MAX_OPS_PER_FN) out.push(open);
    }
    for (const c of fn.calls) {
      const target = resolveCallee(file, fn, c);
      if (!target) continue;
      called.add(target.id);
      const inner = effOps(target.id, target.file, target.fn);
      if (inner.length === 0) continue;
      const env: Env = { args: c.args, defaults: target.fn.defaults, recv: target.recv };
      const here = loc(c.line, c.sym);
      for (const op of inner) {
        const usesSelf = op.slots.some(hasSelf);
        const bound = usesSelf && target.recv !== "self";
        const recvObj = bound && target.recv && target.recv !== "self" ? asObj(target.recv) : undefined;
        let h = op.h;
        if (h?.k === "param") {
          const arg = c.args[h.i];
          h = arg?.k === "param" ? { k: "param", i: arg.i } : { k: "arg", i: h.i, at: here };
        }
        // A publish made by a call inside the receiver's own method (a consumer's retry publish) stays at that
        // call: that method is where it happens. One that is the receiver's (inherited) wrapper method itself
        // is recorded here, at the caller, like any wrapper call.
        const recvCls = recvObj ? classOf(recvObj.cls) : undefined;
        const stay = bound && (op.m === "publish" || op.m === "sendToQueue") && recvCls !== undefined && target.owner !== undefined
          && recvCls.file === target.owner.file && recvCls.cls.name === target.owner.name && locKey(op.last) !== locKey(op.origin);
        const at = stay ? op.last : here;
        const next: Inst = {
          ...op, slots: op.slots.map((s) => sub(s, env)), last: at, self: op.self || bound,
          ...(h ? { h } : {}), ...(recvObj && !op.concrete ? { concrete: recvObj.cls } : {}),
        };
        const open = settle(next, at, "call");
        if (open && out.length < MAX_OPS_PER_FN) out.push(open);
      }
    }
    busy.delete(id);
    memo.set(id, out);
    return out;
  };

  for (const f of files) for (const fn of Object.values(f.fns)) effOps(`${f.file}#${fn.key}`, f.file, fn);

  // Every non-abstract class on its own: its methods' ops that wait only for `this`.
  for (const f of files) {
    for (const cls of Object.values(f.classes)) {
      if (cls.abstract) continue;
      const ref: QRef = { file: f.file, name: cls.name };
      const recv: QV = { k: "obj", cls: ref, args: null };
      const seen = new Set<string>();
      for (let cur: { file: string; cls: QClass } | undefined = { file: f.file, cls }, depth = 0; cur && depth < 8; depth++) {
        for (const fn of Object.values(byFile.get(cur.file)!.fns)) {
          if (fn.cls !== cur.cls.name || fn.isStatic) continue;
          const method = fn.key.slice(cur.cls.name.length + 1);
          if (seen.has(method)) continue; // overridden lower down
          seen.add(method);
          const inherited = cur.cls !== cls;
          for (const op of memo.get(`${cur.file}#${fn.key}`) ?? []) {
            if (!op.slots.some(hasSelf) || op.slots.some(hasParam)) continue;
            const env: Env = { args: null, defaults: [], recv };
            const next: Inst = { ...op, slots: op.slots.map((s) => sub(s, env)), self: true, concrete: op.concrete ?? ref };
            settle(next, next.last, "class", inherited);
          }
        }
        cur = cur.cls.ext ? classOf(cur.cls.ext) : undefined;
      }
    }
  }
  for (const fb of fallbacks) {
    if (emittedValues.has(`${locKey(fb.inst.origin)}\0${fb.values.join("\0")}`)) continue;
    const c = fb.inst.concrete ? classOf(fb.inst.concrete) : undefined;
    const ownerSame = c && fb.inst.owner && fb.inst.owner.file === c.file && fb.inst.owner.name === c.cls.name;
    const at = c && !ownerSame ? { file: c.file, line: c.cls.line, symbol: c.cls.name } : fb.inst.origin;
    record(fb.inst, fb.values, at);
  }

  // ---- what could not be read -----------------------------------------------------------------------
  const unknown = new Map<string, QueueUnknown>();
  const addUnknown = (inst: Inst, at0: Loc): void => {
    if (inst.m !== "publish" && inst.m !== "sendToQueue" && inst.m !== "consume") return;
    const at = inst.m === "consume" ? placeOf(inst, at0).at : at0;
    const known = inst.slots.map((s) => (s && !isOpen(s) ? str(s) : undefined));
    const u: QueueUnknown = { at, op: inst.m === "consume" ? "consume" : "publish", missing: [] };
    if (inst.m === "publish") {
      if (known[0] !== undefined) u.exchange = known[0];
      else u.missing.push("exchange");
      if (known[1] !== undefined) u.routingKey = known[1];
      else u.missing.push("routingKey");
    } else if (known[0] !== undefined) u.queue = known[0];
    else u.missing.push("queue");
    if (u.missing.length === 0) return;
    if (inst.m === "consume") {
      const place = placeOf(inst, at0);
      if (place.handler) u.handler = place.handler;
    }
    const key = `${locKey(u.at)}\0${u.op}\0${u.queue ?? ""}\0${u.exchange ?? ""}\0${u.routingKey ?? ""}`;
    if (!unknown.has(key)) unknown.set(key, u);
  };
  for (const d of deads) {
    if (d.kind === "origin" && emittedFns.has(fnKeyOf(d.inst.origin))) continue;
    if (d.kind === "call" && emittedAt.has(locKey(d.at))) continue;
    if (d.kind === "class" && (emittedFns.has(fnKeyOf(d.inst.origin)) || d.inst.slots.some(hasParam))) continue;
    addUnknown(d.inst, d.at);
  }
  // Ops still waiting for a parameter in a function nothing here calls: the name is lost there. Not for a
  // wrapper's own API nobody here uses (the function holding the amqplib call, or a method of a class that has
  // one): that is a library left unused, not a lost name.
  const amqpClasses = new Set<string>();
  const fnMeta = new Map<string, { file: string; fn: QFn }>();
  for (const f of files) {
    for (const fn of Object.values(f.fns)) {
      fnMeta.set(`${f.file}#${fn.key}`, { file: f.file, fn });
      if (fn.amqp.length > 0 && fn.cls !== undefined) amqpClasses.add(`${f.file}#${fn.cls}`);
    }
  }
  for (const [id, list] of memo) {
    if (called.has(id)) continue;
    const meta = fnMeta.get(id);
    if (meta?.fn.cls !== undefined && amqpClasses.has(`${meta.file}#${meta.fn.cls}`)) continue;
    for (const inst of list) {
      if (!inst.slots.some(hasParam)) continue;
      if (emittedAt.has(locKey(inst.last))) continue;
      if (locKey(inst.last) === locKey(inst.origin)) continue;
      addUnknown(inst, inst.last);
    }
  }

  return { ops: [...ops.values()], exchanges: [...exchanges.values()], unknown: [...unknown.values()] };
}
