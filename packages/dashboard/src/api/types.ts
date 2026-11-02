/** Response shapes the dashboard reads: type-only re-exports of the server's own types
 * (packages/cli/src/web/api-types.ts, via the `codeloom` workspace devDependency). No runtime code
 * crosses over; `import type` is erased at build time. */

export type * from "codeloom/src/web/api-types.ts";
export type { OverviewResponse as Overview } from "codeloom/src/web/api-types.ts";
