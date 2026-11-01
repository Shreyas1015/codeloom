# realworld

The RealWorld ("Conduit") reference pair: a React + Redux UI and an Express + Prisma API, both implementing
the public RealWorld API spec (https://realworld-docs.netlify.app/specifications/backend/endpoints/).

- UI (`ui/`): https://github.com/gothinkster/react-redux-realworld-example-app @ `ee72eba4056392c95a27bc48d385d3f54ba38a18` — licence: MIT (`LICENSE`)
- API (`api/`): https://github.com/gothinkster/node-express-prisma-v1-official-app @ `6ac99ea5aeadc4e001dd4d6933c2e269f878a969` — licence: MIT (`LICENSE.api`)

Why this API and not the one the plan named: `gothinkster/node-express-realworld-example-app` (HEAD
`30b68e1e881462b2f4164ea09ab4c4f5699c7b0b`) has no LICENSE file (only `"license": "MIT"` in package.json), so
it was not vendored. `node-express-prisma-v1-official-app` is the same org's earlier official Express API and
ships an MIT LICENSE file.

Trimmed: kept source files (`.ts`/`.tsx`/`.js`/`.jsx`), `package.json`, `tsconfig.json`, and schema/migration
files only. Dropped: `node_modules`, `.git`, lockfiles, build output, CI/Docker config, docs, images, styles,
`public/`, seed scripts, and the project's own tests (`*.spec.ts`, `test/`, `tests/`, `jest.config.js`).
No file was edited.

Both original licence files are kept alongside this file, unmodified, per their terms (`LICENSE` = UI,
`LICENSE.api` = API; different copyright lines).
