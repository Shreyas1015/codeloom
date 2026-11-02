import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { dataError } from "../../errors.js";

export type SpanKind = "server" | "client" | "internal" | "producer" | "consumer" | "unspecified";

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string; // resource service.name ("" if absent)
  kind: SpanKind;
  http?: { method: string; route?: string; path?: string }; // method upper-cased
  db?: { system?: string; table?: string; op?: string; statement?: string };
  messaging?: { destination: string; op?: string };
}

const KIND_BY_NUMBER: Record<number, SpanKind> = {
  0: "unspecified",
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

const KIND_BY_NAME: Record<string, SpanKind> = {
  SPAN_KIND_UNSPECIFIED: "unspecified",
  SPAN_KIND_INTERNAL: "internal",
  SPAN_KIND_SERVER: "server",
  SPAN_KIND_CLIENT: "client",
  SPAN_KIND_PRODUCER: "producer",
  SPAN_KIND_CONSUMER: "consumer",
};

function spanKindOf(raw: unknown): SpanKind {
  if (typeof raw === "number") return KIND_BY_NUMBER[raw] ?? "unspecified";
  if (typeof raw === "string") return KIND_BY_NAME[raw] ?? "unspecified";
  return "unspecified";
}

/** OTLP AnyValue -> a plain string, or undefined when the value holds none of the known kinds. */
function anyValueToString(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.intValue === "string" || typeof v.intValue === "number") return String(v.intValue);
  if (typeof v.boolValue === "boolean") return String(v.boolValue);
  if (typeof v.doubleValue === "number") return String(v.doubleValue);
  return undefined;
}

/** First matching key (in order) among an OTLP KeyValue[] attributes array. */
function findAttr(attributes: unknown, keys: string[]): string | undefined {
  if (!Array.isArray(attributes)) return undefined;
  for (const key of keys) {
    for (const entry of attributes) {
      if (!entry || typeof entry !== "object") continue;
      const kv = entry as Record<string, unknown>;
      if (kv.key !== key) continue;
      const text = anyValueToString(kv.value);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

/** Normalises a quoted / schema-qualified SQL identifier to its bare table name. */
function stripIdentifier(raw: string): string {
  const unquoted = raw.replace(/[`"'[\]]/g, "");
  const parts = unquoted.split(".");
  return parts[parts.length - 1];
}

const STATEMENT_PATTERNS: Array<[RegExp, string]> = [
  [/^select\b[\s\S]*?\bfrom\s+([^\s,;()]+)/i, "read"],
  [/^insert\s+into\s+([^\s,;()]+)/i, "insert"],
  [/^update\s+([^\s,;()]+)/i, "update"],
  [/^delete\s+from\s+([^\s,;()]+)/i, "delete"],
];

/** Derives { table, op } from a raw SQL statement when no table attribute was present. */
function deriveFromStatement(statement: string): { table?: string; op?: string } {
  const cleaned = statement.trim();
  for (const [pattern, op] of STATEMENT_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) return { table: stripIdentifier(match[1]), op };
  }
  return {};
}

/** Normalises an OTLP id to lowercase hex. Already-hex ids (32 chars for a trace id, 16 for a
 * span id) are lower-cased as is; anything else is treated as base64 (the protobuf-JSON mapping)
 * and decoded to hex. */
function normalizeId(raw: string): string {
  if (/^[0-9a-fA-F]{32}$/.test(raw) || /^[0-9a-fA-F]{16}$/.test(raw)) {
    return raw.toLowerCase();
  }
  return Buffer.from(raw, "base64").toString("hex").toLowerCase();
}

function buildHttp(attributes: unknown): TraceSpan["http"] {
  const method = findAttr(attributes, ["http.request.method", "http.method"]);
  const route = findAttr(attributes, ["http.route"]);
  const rawPath = findAttr(attributes, ["url.path", "http.target"]);
  const path = rawPath?.split("?")[0];
  if (method === undefined && route === undefined && path === undefined) return undefined;
  return { method: (method ?? "").toUpperCase(), route, path };
}

function buildDb(attributes: unknown): TraceSpan["db"] {
  const system = findAttr(attributes, ["db.system", "db.system.name"]);
  let table = findAttr(attributes, ["db.collection.name", "db.sql.table", "db.mongodb.collection"]);
  let op = findAttr(attributes, ["db.operation.name", "db.operation"]);
  const statement = findAttr(attributes, ["db.query.text", "db.statement"]);
  if (table === undefined && statement !== undefined) {
    const derived = deriveFromStatement(statement);
    table = table ?? derived.table;
    op = op ?? derived.op;
  }
  if (system === undefined && table === undefined && op === undefined && statement === undefined) return undefined;
  return { system, table, op, statement };
}

function buildMessaging(attributes: unknown): TraceSpan["messaging"] {
  const destination = findAttr(attributes, ["messaging.destination.name", "messaging.destination"]);
  if (destination === undefined) return undefined;
  const op = findAttr(attributes, ["messaging.operation.type", "messaging.operation"]);
  return { destination, op };
}

function buildSpan(raw: unknown, service: string): TraceSpan | null {
  if (!raw || typeof raw !== "object") return null;
  const span = raw as Record<string, unknown>;
  const rawTraceId = span.traceId;
  const rawSpanId = span.spanId;
  if (typeof rawTraceId !== "string" || rawTraceId === "" || typeof rawSpanId !== "string" || rawSpanId === "") {
    return null;
  }
  const rawParentId = span.parentSpanId;
  const parentSpanId = typeof rawParentId === "string" && rawParentId !== "" ? normalizeId(rawParentId) : undefined;

  return {
    traceId: normalizeId(rawTraceId),
    spanId: normalizeId(rawSpanId),
    parentSpanId,
    service,
    kind: spanKindOf(span.kind),
    http: buildHttp(span.attributes),
    db: buildDb(span.attributes),
    messaging: buildMessaging(span.attributes),
  };
}

/** Each resourceSpans / batches entry: a resource plus one or more scope groups, old or new naming. */
function spanGroupsOf(entry: Record<string, unknown>): unknown[] {
  if (Array.isArray(entry.scopeSpans)) return entry.scopeSpans;
  if (Array.isArray(entry.instrumentationLibrarySpans)) return entry.instrumentationLibrarySpans;
  return [];
}

/** Accepts an OTLP JSON export object ({ resourceSpans }) or Tempo's legacy ({ batches }) shape. */
export function spansFromOtlp(doc: unknown): TraceSpan[] {
  if (!doc || typeof doc !== "object") {
    throw dataError("OTLP document must be a JSON object");
  }
  const top = doc as Record<string, unknown>;
  const groups: unknown[] = Array.isArray(top.resourceSpans)
    ? top.resourceSpans
    : Array.isArray(top.batches)
      ? top.batches
      : (() => {
          throw dataError('OTLP document must have a "resourceSpans" or "batches" array');
        })();

  const spans: TraceSpan[] = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const entry = group as Record<string, unknown>;
    const resource = entry.resource;
    const resourceAttrs = resource && typeof resource === "object"
      ? (resource as Record<string, unknown>).attributes
      : undefined;
    const service = findAttr(resourceAttrs, ["service.name"]) ?? "";

    for (const scopeGroup of spanGroupsOf(entry)) {
      if (!scopeGroup || typeof scopeGroup !== "object") continue;
      const scopeSpans = (scopeGroup as Record<string, unknown>).spans;
      if (!Array.isArray(scopeSpans)) continue;
      for (const rawSpan of scopeSpans) {
        const span = buildSpan(rawSpan, service);
        if (span) spans.push(span);
      }
    }
  }
  return spans;
}

/** Reads a .json file (one export) or .jsonl/.ndjson (one export per line). Missing/unreadable → dataError. */
export function readOtlpFile(path: string): TraceSpan[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw dataError(`could not read OTLP trace file: ${path}`);
  }

  const ext = extname(path).toLowerCase();
  if (ext === ".jsonl" || ext === ".ndjson") {
    const spans: TraceSpan[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let doc: unknown;
      try {
        doc = JSON.parse(trimmed);
      } catch {
        throw dataError(`${path} is not valid JSON: one line failed to parse`);
      }
      spans.push(...spansFromOtlp(doc));
    }
    return spans;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw dataError(`${path} is not valid JSON`);
  }
  return spansFromOtlp(doc);
}
