import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { EVAL_THRESHOLDS, formatScore, scoreChains } from "../src/evals/score.js";
import { CODELOOM_DIR, FILES } from "../src/store/paths.js";
import { ChainsFileSchema, ExpectedJourneysSchema, type ExpectedHop } from "../src/store/schemas.js";
import { materializeEval } from "./helpers.js";

const EVALS_DIR = fileURLToPath(new URL("../../../fixtures/evals", import.meta.url));

function listApps(): string[] {
  return readdirSync(EVALS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe("vendored eval apps meet the precision/recall gate", () => {
  const apps = listApps();

  it("has at least one vendored eval app", () => {
    expect(apps.length).toBeGreaterThan(0);
  });

  for (const app of apps) {
    it(`${app}: precision/recall meet EVAL_THRESHOLDS for every hop type`, async () => {
      const root = materializeEval(app);
      await runIndex(root);
      const chainsFile = ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, CODELOOM_DIR, FILES.chains), "utf8")));
      const key = ExpectedJourneysSchema.parse(JSON.parse(readFileSync(join(EVALS_DIR, app, "expected-journeys.json"), "utf8")));

      const score = scoreChains(key, chainsFile.chains);
      console.log(`\n${app}\n${formatScore(score)}`);

      for (const type of Object.keys(EVAL_THRESHOLDS) as Array<ExpectedHop["type"]>) {
        const s = score[type];
        const t = EVAL_THRESHOLDS[type];
        expect(
          s.precision,
          `${app} ${type} precision ${s.precision} < ${t.precision}; extra=${s.extra.join(", ") || "(none)"}`,
        ).toBeGreaterThanOrEqual(t.precision);
        expect(
          s.recall,
          `${app} ${type} recall ${s.recall} < ${t.recall}; missing=${s.missing.join(", ") || "(none)"}`,
        ).toBeGreaterThanOrEqual(t.recall);
      }
    }, 120_000);
  }
});
