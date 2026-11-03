/** H6: calls `codeloom check` leaves out of its info-only "Calls that could not be resolved" list —
 * language built-ins, never a lost hop in the app's own code. */

/** Global objects and functions of the JS runtime (browser and Node). A call on one (`console.log`,
 * `JSON.parse`, `Math.max`) or of one (`setTimeout(...)`, `String(x)`) is never app code. */
export const GLOBAL_BUILTINS: ReadonlySet<string> = new Set([
  // objects / namespaces
  "console", "JSON", "Math", "Object", "Array", "Promise", "Date", "Number", "String", "Boolean", "Symbol", "BigInt",
  "Reflect", "Proxy", "Intl", "Atomics", "Error", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "ArrayBuffer",
  "Buffer", "URL", "URLSearchParams", "globalThis", "window", "document", "navigator", "localStorage",
  "sessionStorage", "crypto", "performance", "process",
  // functions
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "queueMicrotask",
  "requestAnimationFrame", "cancelAnimationFrame", "structuredClone", "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "atob", "btoa", "require",
]);

// TODO(H4 merge): replace this list with part A's exported built-in method name constant in
// linker/resolve-calls.ts once that branch is merged, so the resolver and check share one list.
/** Method names of built-in values (arrays, strings, promises, numbers, dates) whose call on an unknown
 * receiver (`items.map(...)`, `.then(...)`) is never a lost hop. Names that ORMs and services also use
 * (`find`, `get`, `set`, `create`, `delete`, ...) are left out on purpose. */
export const BUILTIN_METHOD_NAMES: ReadonlySet<string> = new Set([
  "map", "filter", "forEach", "reduce", "reduceRight", "some", "every", "findIndex", "findLast", "findLastIndex",
  "includes", "indexOf", "lastIndexOf", "push", "pop", "shift", "unshift", "slice", "splice", "concat", "join",
  "flat", "flatMap", "sort", "reverse", "fill", "at",
  "then", "catch", "finally",
  "toString", "toFixed", "toPrecision", "toLocaleString", "toLocaleDateString", "toISOString", "toJSON", "valueOf",
  "getTime", "trim", "trimStart", "trimEnd", "split", "replace", "replaceAll", "toLowerCase", "toUpperCase",
  "startsWith", "endsWith", "padStart", "padEnd", "charAt", "charCodeAt", "substring", "substr", "repeat",
  "localeCompare", "normalize", "hasOwnProperty",
]);

/** The callee in an unresolved-call reason the linker writes (`could not resolve "res.json(...)"`), or
 * undefined for any other reason text. */
export function calleeOf(reason: string): string | undefined {
  return reason.match(/^could not resolve "(.+)\(\.\.\.\)"$/)?.[1];
}

/** True for a call on or of a global built-in, or of a built-in method name on some value
 * (`this.items.push`). `new X().m` and `this.m` callees are app code. */
export function isBuiltinCallee(callee: string): boolean {
  if (callee.startsWith("new ")) return false;
  if (callee.startsWith("this.")) {
    const rest = callee.slice("this.".length).split(".");
    return rest.length > 1 && BUILTIN_METHOD_NAMES.has(rest[rest.length - 1]!);
  }
  const parts = callee.split(".");
  if (parts.length === 1) return GLOBAL_BUILTINS.has(callee);
  if (GLOBAL_BUILTINS.has(parts[0]!)) return true;
  return BUILTIN_METHOD_NAMES.has(parts[parts.length - 1]!);
}
