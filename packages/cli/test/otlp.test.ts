import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import { readOtlpFile, spansFromOtlp, type TraceSpan } from "../src/check/traces/otlp.js";

const FIXTURES = fileURLToPath(new URL("fixtures/otlp/", import.meta.url));
const fixture = (name: string) => join(FIXTURES, name);

describe("spansFromOtlp", () => {
  it("parses new-semconv resourceSpans: route/path/db/messaging attributes, and ignores spans with no ids", () => {
    const spans = readOtlpFile(fixture("new-semconv.json"));
    expect(spans).toHaveLength(3);

    const [server, db, messaging] = spans as [TraceSpan, TraceSpan, TraceSpan];

    expect(server).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      service: "api",
      kind: "server",
      http: { method: "POST", route: "/api/customers", path: "/api/customers" },
    });
    expect(server.parentSpanId).toBeUndefined();

    expect(db).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "3c3eae9c3c3eae9c",
      parentSpanId: "00f067aa0ba902b7",
      service: "api",
      kind: "client",
      db: {
        system: "postgresql",
        table: "customers",
        op: "insert",
        statement: "INSERT INTO customers (name) VALUES ($1)",
      },
    });

    expect(messaging).toMatchObject({
      spanId: "5f3f3e3f3f3e3f3f",
      kind: "producer",
      messaging: { destination: "invoice.created", op: "publish" },
    });
  });

  it("parses old-semconv attributes (http.method/http.target with query, db.statement, messaging.destination)", () => {
    const spans = readOtlpFile(fixture("old-semconv.json"));
    expect(spans).toHaveLength(3);
    const [client, db, producer] = spans as [TraceSpan, TraceSpan, TraceSpan];

    expect(client).toMatchObject({
      service: "web",
      kind: "client",
      http: { method: "GET", path: "/api/customers/42" },
    });
    expect(client.http?.route).toBeUndefined();

    expect(db).toMatchObject({
      service: "web",
      db: { system: "postgresql", table: "invoices", op: "select" },
    });

    expect(producer).toMatchObject({
      service: "web",
      kind: "producer",
      messaging: { destination: "invoice.created", op: "publish" },
    });
  });

  it("parses Tempo's legacy batches shape, decoding base64 ids to lowercase hex", () => {
    const spans = readOtlpFile(fixture("legacy-batches.json"));
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b9c7c989f97918e1",
      parentSpanId: "a1b2c3d4e5f6a7b8",
      service: "billing",
      kind: "consumer",
      messaging: { destination: "invoice.created", op: "process" },
    });
  });

  it("derives table and op from the SQL statement when no table attribute is present", () => {
    const spans = readOtlpFile(fixture("statement-derived.json"));
    expect(spans).toHaveLength(2);
    expect(spans[0].db).toMatchObject({ table: "invoices", op: "update" });
    expect(spans[1].db).toMatchObject({ table: "customers", op: "read" });
  });

  it("defaults service to \"\" when service.name is absent from resource attributes", () => {
    const spans = readOtlpFile(fixture("missing-service.json"));
    expect(spans).toHaveLength(1);
    expect(spans[0].service).toBe("");
  });

  it("throws dataError on a malformed document (no resourceSpans or batches)", () => {
    expect(() => spansFromOtlp({ notAnOtlpExport: true })).toThrow(CodeloomError);
    try {
      spansFromOtlp({ notAnOtlpExport: true });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CodeloomError);
      expect((err as CodeloomError).exitCode).toBe(2);
    }
  });
});

describe("readOtlpFile", () => {
  it("reads a .json file as one export", () => {
    const spans = readOtlpFile(fixture("new-semconv.json"));
    expect(spans.length).toBeGreaterThan(0);
  });

  it("reads a .jsonl file as one export per line", () => {
    const spans = readOtlpFile(fixture("two-exports.jsonl"));
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ service: "web", kind: "client" });
    expect(spans[1]).toMatchObject({ service: "api", kind: "server", parentSpanId: "00f067aa0ba902b7" });
  });

  it("throws dataError for a malformed document read from a file", () => {
    expect(() => readOtlpFile(fixture("malformed.json"))).toThrow(CodeloomError);
  });

  it("throws dataError for a missing file", () => {
    expect(() => readOtlpFile(fixture("does-not-exist.json"))).toThrow(CodeloomError);
    try {
      readOtlpFile(fixture("does-not-exist.json"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CodeloomError);
      expect((err as CodeloomError).exitCode).toBe(2);
    }
  });
});
