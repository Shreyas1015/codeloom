/** Same-origin JSON fetch for the local codeloom server. The session cookie rides along. */

import type { ApiErrorCode } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 401: the session cookie is missing or stale (the server restarted with a new token). */
export class SessionError extends ApiError {
  constructor(message = "Your dashboard session expired. Open the link that codeloom dashboard printed.") {
    super(message, 401);
    this.name = "SessionError";
  }
}

/** 409: the map itself is not usable (no workspace, not indexed yet, or a bad .codeloom file). */
export class MapStateError extends ApiError {
  constructor(
    message: string,
    readonly code: ApiErrorCode,
  ) {
    super(message, 409);
    this.name = "MapStateError";
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export function apiUrl(path: string, params?: QueryParams): string {
  if (!params) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

async function errorMessage(res: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    return {
      message: typeof body.error === "string" ? body.error : `Request failed (${res.status})`,
      ...(typeof body.code === "string" ? { code: body.code } : {}),
    };
  } catch {
    return { message: `Request failed (${res.status})` };
  }
}

export async function apiGet<T>(path: string, params?: QueryParams): Promise<T> {
  const res = await fetch(apiUrl(path, params), { credentials: "same-origin", headers: { accept: "application/json" } });
  return readResponse<T>(res);
}

/** Same-origin JSON POST: only the two progress writes take one (the server refuses any other). */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readResponse<T>(res);
}

async function readResponse<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  const { message, code } = await errorMessage(res);
  if (res.status === 401) throw new SessionError();
  if (res.status === 409) throw new MapStateError(message, code === "bad-data" || code === "no-workspace" ? code : "not-indexed");
  throw new ApiError(message, res.status);
}
