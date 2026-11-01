# prisma-rest-nextjs

Next.js (App Router pages + `pages/api` routes) with Prisma, UI and API in one app.

- App (`app/`): https://github.com/prisma/prisma-examples, sub-directory `orm/rest-nextjs-api-routes` @ `76e9674e3a9a42b786401c52e2f05b2b52c198b9` — licence: Apache-2.0 (repo root `LICENSE`)

Why this commit: the example was removed from prisma-examples in the next commit (`aea37c46a`, "change
naming scheme", 2024-12-05); `76e9674e3a9a42b786401c52e2f05b2b52c198b9` is the last commit that has it.
The monorepo's root Apache-2.0 `LICENSE` at that commit covers it.

Trimmed: kept source files (`.ts`/`.tsx`/`.js`/`.jsx`), `package.json`, `tsconfig.json`, and schema/migration
files only. Dropped: `node_modules`, `.git`, lockfiles, build output, CI/Docker config, docs, images, styles,
`public/`, seed scripts, and the project's own tests (`*.spec.ts`, `test/`, `tests/`, `jest.config.js`).
No file was edited.

Original `LICENSE` is kept alongside this file, unmodified, per its terms.
