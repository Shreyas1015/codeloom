import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom has no scrolling; the router's scroll restoration calls it.
if (typeof window !== "undefined") window.scrollTo = () => {};

// jsdom has no ResizeObserver; Radix popper (tooltips) measures with it.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom implements no SubtleCrypto; the Review code panel hashes a file path for its GitHub link
// (crypto.subtle.digest). Node's own webcrypto has it, so borrow that one function in tests.
// `subtle` is typed read-only on Crypto; jsdom's instance never defines it, so this adds it rather
// than reassigning an existing property.
if (typeof globalThis.crypto?.subtle === "undefined") {
  Object.defineProperty(globalThis.crypto, "subtle", { value: webcrypto.subtle, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
