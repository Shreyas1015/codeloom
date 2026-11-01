import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { detectMounts, detectRouters } from "../src/adapters/routes.js";
import { finalizeEndpoints, runAdapters, type ImportResolver } from "../src/adapters/run.js";
import { effectiveRoutes } from "../src/linker/mounts.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

const ctx = ctxWith("express");

/** Resolves relative specifiers to `<dir>/<spec>.ts` when that file is one of `files`. */
function resolverFor(files: string[]): ImportResolver {
  return (from, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    for (const cand of [`${base}.ts`, `${base}/index.ts`]) if (files.includes(cand)) return cand;
    return null;
  };
}

/** Index a set of files as one repo and return "METHOD effectivePath known|unknown" per route. */
function effective(files: Record<string, string>): string[] {
  const rels = Object.keys(files);
  const parts = rels.map((rel) => runAdapters(rel, files[rel]!, ctx));
  const ep = finalizeEndpoints("api", parts, resolverFor(rels));
  return effectiveRoutes(ep)
    .map((e) => `${e.route.method} ${e.effectivePath} ${e.mountsKnown ? "known" : "unknown"}`)
    .sort();
}

// Minimal copy of fixtures/evals/realworld/api: controllers export a Router(), routes.ts chains them
// onto an un-prefixed `api` router and default-exports an anonymous Router().use('/api', api), and
// index.ts does a prefix-less app.use(routes).
const ARTICLES = `
  import { Router } from 'express';
  const router = Router();
  router.get('/articles/:slug', async (req, res) => res.json({}));
  router.get('/articles', async (req, res) => res.json({}));
  export default router;
`;
const TAGS = `
  import { Router } from 'express';
  const router = Router();
  router.get('/tags', async (req, res) => res.json({}));
  export default router;
`;
const ROUTES = `
  import { Router } from 'express';
  import tagsController from '../controllers/tag.controller';
  import articlesController from '../controllers/article.controller';
  const api = Router()
    .use(tagsController)
    .use(articlesController);
  export default Router().use('/api', api);
`;
const INDEX = `
  import express from 'express';
  import cors from 'cors';
  import routes from './routes/routes';
  const app = express();
  app.use(cors());
  app.use(routes);
  app.get('/', (req, res) => res.json({}));
`;

describe("detectRouters", () => {
  const routers = (rel: string, code: string) =>
    detectRouters(parsed(rel, code), ctx).map((r) => `${r.name} as=${r.exports.join("|") || "<none>"}${r.app ? " app" : ""}`);

  it("records a default-exported factory router", () => {
    expect(routers("src/controllers/article.controller.ts", ARTICLES)).toEqual(["router as=default"]);
  });

  it("records an anonymous default-exported router chain as 'default'", () => {
    expect(routers("src/routes/routes.ts", ROUTES)).toEqual(["default as=default"]);
  });

  it("records named, renamed and CommonJS exports", () => {
    expect(routers("a.ts", `
      import express from 'express';
      export const users = express.Router();
      const billing = express.Router();
      export { billing as billingRouter };
    `)).toEqual(["billing as=billingRouter", "users as=users"]);
    expect(routers("b.js", `
      const express = require('express');
      const router = express.Router();
      module.exports = router;
    `)).toEqual(["router as=default"]);
  });

  it("marks an express() app as an app, exported or not", () => {
    expect(routers("server.ts", `
      import express from 'express';
      const app = express();
      export default app;
    `)).toEqual(["app as=default app"]);
    expect(routers("server2.ts", INDEX)).toEqual(["app as=<none> app"]);
  });

  it("ignores exports that are not routers", () => {
    expect(routers("c.ts", `
      import { Router } from 'express';
      export const helper = () => 1;
      export default { a: 1 };
    `)).toEqual([]);
  });
});

describe("detectMounts: router-level and prefix-less mounts", () => {
  const mounts = (rel: string, code: string, ...deps: string[]) =>
    detectMounts(parsed(rel, code), ctxWith(...(deps.length ? deps : ["express"]))).map(
      (m) =>
        `${m.prefix || "<root>"} on=${m.on} target=${m.target.name ?? "<none>"}` +
        `${m.targetImport ? ` import=${m.targetImport}` : ""}${m.target.export ? ` export=${m.target.export}` : ""}` +
        `${m.onImport ? ` onImport=${m.onImport}#${m.onExport}` : ""}`,
    );

  it("reads the realworld chained .use() calls, onto the variable and onto an anonymous default export", () => {
    expect(mounts("src/routes/routes.ts", ROUTES)).toEqual([
      "<root> on=api target=tagsController import=../controllers/tag.controller export=default",
      "<root> on=api target=articlesController import=../controllers/article.controller export=default",
      "/api on=default target=api",
    ]);
  });

  it("reads a prefix-less app.use(router) and skips non-identifier middleware", () => {
    expect(mounts("src/index.ts", INDEX)).toEqual(["<root> on=app target=routes import=./routes/routes export=default"]);
  });

  it("records the imported name of a named-import target", () => {
    expect(mounts("server.ts", `
      import express from 'express';
      import { billingRouter as billing } from './billing';
      const app = express();
      app.use('/billing', billing);
    `)).toEqual(["/billing on=app target=billing import=./billing export=billingRouter"]);
  });

  it("reads an inline require() target as the default export", () => {
    expect(mounts("server.js", `
      const express = require('express');
      const app = express();
      app.use('/api', require('./routes/api'));
    `)).toEqual(["/api on=app target=<none> import=./routes/api export=default"]);
  });

  it("reads a mount onto a router imported from another file", () => {
    expect(mounts("src/admin.ts", `
      import api from './api';
      import adminRouter from './admin-router';
      api.use('/admin', adminRouter);
    `)).toEqual(["/admin on=api target=adminRouter import=./admin-router export=default onImport=./api#default"]);
  });

  it("does not treat a multi-argument use() without a literal prefix as a mount", () => {
    expect(mounts("server.ts", `
      import express from 'express';
      const app = express();
      const billing = express.Router();
      app.use(prefixVar, billing);
      app.use(auth, billing);
    `)).toEqual([]);
  });
});

describe("effectiveRoutes: router-level mounts across files", () => {
  it("composes the realworld three-level shape into /api/... with mountsKnown: true", () => {
    expect(effective({
      "src/index.ts": INDEX,
      "src/routes/routes.ts": ROUTES,
      "src/controllers/article.controller.ts": ARTICLES,
      "src/controllers/tag.controller.ts": TAGS,
    })).toEqual([
      "GET / known",
      "GET /api/articles known",
      "GET /api/articles/:slug known",
      "GET /api/tags known",
    ]);
  });

  it("marks an exported router that is never mounted as mountsKnown: false", () => {
    expect(effective({ "src/controllers/article.controller.ts": ARTICLES })).toEqual([
      "GET /articles unknown",
      "GET /articles/:slug unknown",
    ]);
  });

  it("marks routes unknown when the outermost router is exported but never mounted by an app", () => {
    // routes.ts is complete down to its anonymous default router, but no app mounts it.
    expect(effective({
      "src/routes/routes.ts": ROUTES,
      "src/controllers/tag.controller.ts": TAGS,
    })).toEqual(["GET /api/tags unknown"]);
  });

  it("applies a prefix-less app.use(router) of a default-imported router", () => {
    expect(effective({
      "src/server.ts": `
        import express from 'express';
        import router from './router';
        const app = express();
        app.use(router);
      `,
      "src/router.ts": TAGS,
    })).toEqual(["GET /tags known"]);
  });

  it("applies a prefixed mount via a default-imported router", () => {
    expect(effective({
      "src/server.ts": `
        import express from 'express';
        import tags from './router';
        const app = express();
        app.use('/v1', tags);
      `,
      "src/router.ts": TAGS,
    })).toEqual(["GET /v1/tags known"]);
  });

  it("matches a named-import mount only to the router exported under that name", () => {
    expect(effective({
      "src/server.ts": `
        import express from 'express';
        import { admin } from './routers';
        const app = express();
        app.use('/admin', admin);
      `,
      "src/routers.ts": `
        import { Router } from 'express';
        export const admin = Router();
        admin.get('/stats', (req, res) => res.json({}));
        const pub = Router();
        pub.get('/hello', (req, res) => res.json({}));
        export default pub;
      `,
    })).toEqual(["GET /admin/stats known", "GET /hello unknown"]);
  });

  it("does not prefix routes with an imported middleware mount", () => {
    expect(effective({
      "src/server.ts": `
        import express from 'express';
        import requireAuth from './auth';
        import router from './router';
        const app = express();
        app.use('/api', requireAuth);
        app.use('/api', router);
      `,
      "src/auth.ts": `export default function requireAuth(req, res, next) { next(); }`,
      "src/router.ts": TAGS,
    })).toEqual(["GET /api/tags known"]);
  });

  it("follows a mount onto a router imported from another file", () => {
    expect(effective({
      "src/server.ts": `
        import express from 'express';
        import api from './api';
        const app = express();
        app.use('/api', api);
      `,
      "src/api.ts": `
        import { Router } from 'express';
        const api = Router();
        export default api;
      `,
      "src/admin.ts": `
        import api from './api';
        import adminRouter from './admin-router';
        api.use('/admin', adminRouter);
      `,
      "src/admin-router.ts": `
        import { Router } from 'express';
        const r = Router();
        r.get('/stats', (req, res) => res.json({}));
        export default r;
      `,
    })).toEqual(["GET /api/admin/stats known"]);
  });

  it("keeps an exported express() app's own routes known (exported only for tests)", () => {
    // The only express() app codeloom finds anywhere in this repo, so it has to be the entry point
    // regardless of the (test-only) export.
    expect(effective({
      "src/app.ts": `
        import express from 'express';
        const server = express();
        server.get('/health', (req, res) => res.json({}));
        export default server;
      `,
    })).toEqual(["GET /health known"]);
  });

  it("composes an express sub-app's own mount under the app it is in turn mounted onto (H1 regression)", () => {
    // admin is itself an express() app; r is mounted onto it at /x, and admin is mounted onto the main
    // app at /admin. The route must resolve through both mounts to /admin/x/stats, not stop at admin's
    // own /x — admin is an app receiver, but something does mount it further out.
    expect(effective({
      "src/server.ts": `
        import express from 'express';
        import { Router } from 'express';
        const app = express();
        const admin = express();
        const r = Router();
        r.get('/stats', (req, res) => res.json({}));
        admin.use('/x', r);
        app.use('/admin', admin);
      `,
    })).toEqual(["GET /admin/x/stats known"]);
  });

  it("marks an exported express() sub-app that is never mounted as unknown, even though it is an app", () => {
    // Two express() apps exist in this repo: "app" (unexported, has its own route) and "admin"
    // (exported but never mounted anywhere). admin is not the only app and is exported, so it looks
    // like a sub-app whose real mount codeloom can't see; its own route must not be reported known.
    expect(effective({
      "src/main.ts": `
        import express from 'express';
        const app = express();
        app.get('/', (req, res) => res.json({}));
      `,
      "src/admin.ts": `
        import express from 'express';
        const admin = express();
        admin.get('/stats', (req, res) => res.json({}));
        export default admin;
      `,
    })).toEqual(["GET / known", "GET /stats unknown"]);
  });

  it("keeps the main app's routes known next to an unrelated, never-mounted sub-app (review finding: isOnlyApp counted every app in the repo)", () => {
    // app.ts's `app` is exported only for tests/supertest, same as the "keeps an exported express() app's
    // own routes known" case above, but this repo also has a second express() app (admin) elsewhere. The
    // old isOnlyApp counted both and downgraded /health to unknown; app's binding name is one of the
    // conventional top-level receiver names, so it must stay known regardless of what else is in the repo.
    expect(effective({
      "src/app.ts": `
        import express from 'express';
        const app = express();
        app.get('/health', (req, res) => res.json({}));
        export default app;
      `,
      "src/admin.ts": `
        import express from 'express';
        export const admin = express();
        admin.get('/stats', (req, res) => res.json({}));
      `,
    })).toEqual(["GET /health known", "GET /stats unknown"]);
  });

  it("keeps each service's main app known in a monorepo with two services under one repo (review finding: isOnlyApp was repo-wide, not per-package)", () => {
    // Two independent services live under one .git/one EndpointsFile, each with its own express() app
    // exported (for tests). Neither is mounted by the other. The old repo-wide isOnlyApp saw 2 apps and
    // downgraded both to unknown; each must be known on its own.
    expect(effective({
      "service-a/src/app.ts": `
        import express from 'express';
        const app = express();
        app.get('/health', (req, res) => res.json({}));
        export default app;
      `,
      "service-b/src/app.ts": `
        import express from 'express';
        const app = express();
        app.get('/status', (req, res) => res.json({}));
        export default app;
      `,
    })).toEqual(["GET /health known", "GET /status known"]);
  });

  it("treats a non-conventionally-named app as the main app when it is the only app in its own package", () => {
    // `svc` isn't one of the conventional top-level receiver names, so this exercises the per-package
    // uniqueness rule directly: svc is the only app under service-a/, so it's known even though a
    // same-named receiver also exists, unmounted, under the unrelated service-b/ package.
    expect(effective({
      "service-a/src/index.ts": `
        import express from 'express';
        const svc = express();
        svc.get('/health', (req, res) => res.json({}));
        export default svc;
      `,
      "service-b/src/index.ts": `
        import express from 'express';
        const svc = express();
        svc.get('/status', (req, res) => res.json({}));
        export default svc;
      `,
    })).toEqual(["GET /health known", "GET /status known"]);
  });

  it("marks a default-imported router unknown when nothing mounts it (negative twin of the prefix-less case)", () => {
    expect(effective({
      "src/server.ts": `
        import express from 'express';
        const app = express();
      `,
      "src/router.ts": TAGS,
    })).toEqual(["GET /tags unknown"]);
  });
});
