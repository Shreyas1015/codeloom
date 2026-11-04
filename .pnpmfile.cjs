// pnpm hooks for this workspace.
// beforePacking: the published codeloom package.json keeps only what an installer needs. Its devDependencies
// (workspace-only @codeloom/core, vitest, types) and dev scripts (build, test, typecheck) are dropped from the
// packed manifest; packages/cli/package.json on disk is never changed. pnpm already drops prepack/prepare.
// Runs for `pnpm pack` and `pnpm publish`; scripts/release/pack-test.sh checks the result.
module.exports = {
  hooks: {
    beforePacking(manifest) {
      if (manifest.name !== "codeloom") return manifest;
      const { devDependencies: _dev, scripts: _scripts, ...rest } = manifest;
      return rest;
    },
  },
};
