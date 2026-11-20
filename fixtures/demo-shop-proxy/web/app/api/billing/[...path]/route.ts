// Same-origin proxy to the billing service. The forwarding lives in lib/server.
import { serviceRoute } from "@/lib/server/route-handlers";

const handler = serviceRoute("billing");

export const GET = handler;
export const POST = handler;
