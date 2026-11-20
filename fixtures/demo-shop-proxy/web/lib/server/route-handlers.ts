import { readServerEnv } from "./env";
import { forwardTo, forwardToLegacy } from "./forward";
import type { ServiceName } from "./services";

type ProxyContext = { params: Promise<{ path: string[] }> };

/** One handler for every method a proxy route exports. */
export function serviceRoute(service: ServiceName) {
  return async (request: Request, context: ProxyContext): Promise<Response> => {
    const { path } = await context.params;
    return forwardTo(request, service, path, readServerEnv());
  };
}

export function legacyRoute() {
  return async (request: Request, context: ProxyContext) => forwardToLegacy(request, (await context.params).path);
}
