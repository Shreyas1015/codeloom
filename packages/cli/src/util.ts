/** Plain code-point string comparator: deterministic across locales and Node builds (unlike
 * `String.prototype.localeCompare`, whose result can depend on the host's ICU/locale data). Used
 * for anything that ends up in a committed file (graph.json, endpoints.json), so ordering only
 * ever depends on code. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
