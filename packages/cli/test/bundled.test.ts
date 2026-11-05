import { describe, expect, it } from "vitest";
import { isBundledFile } from "../src/indexer/bundled.js";

const NORMAL = `import { Invoice } from "./invoice";

export class Customer {
  constructor(private invoices: Invoice[]) {}
  total() {
    return this.invoices.reduce((sum, i) => sum + i.amount, 0);
  }
}
`;

describe("isBundledFile", () => {
  it("skips bundle and minified file names", () => {
    for (const rel of ["public/app.min.js", "dist2/app.bundle.js", ".hooks/session-bundle.cjs", "x/vendor-bundle.mjs"]) {
      expect(isBundledFile(rel, NORMAL), rel).toBe(true);
    }
    for (const rel of ["src/customer.ts", "src/bundle.ts", "src/bundler.js", "src/minify.js", "src/product-bundle.ts", "src/invoice.bundle.tsx"]) {
      expect(isBundledFile(rel, NORMAL), rel).toBe(false);
    }
  });

  it("skips a minified file: one very long line of code", () => {
    const line = Array.from({ length: 80 }, (_, i) => `var a${i}=class{m(){return this.n()}n(){return ${i}}};`).join("");
    expect(line.length).toBeGreaterThan(1000);
    expect(isBundledFile("hooks/run.cjs", `"use strict";\n${line}\n`)).toBe(true);
  });

  it("skips files with bundler markers", () => {
    expect(isBundledFile("out/main.js", `${NORMAL}\nvar m = __webpack_require__(12);\n`)).toBe(true);
    expect(isBundledFile("out/main.js", `/*! For license information please see main.js.LICENSE.txt */\n${NORMAL}`)).toBe(true);
    expect(isBundledFile("hooks/a.cjs", `var __commonJS = (cb, mod) => function () {};\nvar require_x = __commonJS({ "x.js"(exports) {} });\n`)).toBe(true);
    expect(isBundledFile("hooks/b.mjs", `var import_y = __toESM(require_y());\n${NORMAL}`)).toBe(true);
  });

  it("keeps a normal app file, even one with a single long line", () => {
    expect(isBundledFile("src/customer.ts", NORMAL)).toBe(false);
    const longString = `export const INVOICE_TERMS = "${"Payment due within 30 days. ".repeat(50)}";\n`;
    expect(longString.length).toBeGreaterThan(1000);
    const body = Array.from({ length: 60 }, (_, i) => `export function step${i}(c: Customer) {\n  return c.total() + ${i};\n}\n`).join("");
    expect(isBundledFile("src/terms.ts", `${NORMAL}${longString}${body}`)).toBe(false);
    // a sourceMappingURL comment alone is normal build-tool output, not a bundle
    expect(isBundledFile("src/customer.js", `${NORMAL}//# sourceMappingURL=customer.js.map\n`)).toBe(false);
  });
});
