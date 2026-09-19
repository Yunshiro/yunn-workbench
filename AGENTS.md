# Repository Guidelines

## Project Structure & Module Organization

This is a two-package TypeScript application. `server/src/` contains the Express API, SQLite persistence, RSS ingestion, prompts, and agent queue. `web/src/` contains the React/Vite client: pages live in `views/`, shared UI in `components/`, API/SSE helpers in `lib/`, and CSS in `styles/global.css`. Vite builds to `web/dist/`, which the server serves when present.

## Build, Test, and Development Commands

- `npm run install:all` installs dependencies for both packages.
- `npm run dev:server` starts the API with `tsx` watch mode on port `3001` by default.
- `npm run dev:web` starts Vite on port `5173` and proxies `/api` to the server.
- `npm run build:web` type-checks and creates the production client bundle.
- `npm start` runs the server; build the client first for static hosting.
- `cd server && npm exec -- tsc --noEmit` type-checks server code.

Run server and web development commands in separate terminals.

## Coding Style & Naming Conventions

Use strict TypeScript, ES modules, two-space indentation, double quotes, and semicolons. Name React components and exported types in `PascalCase`, functions and variables in `camelCase`, and CSS classes with BEM-like names such as `nav__item--active`. Keep API routes under `/api`; map `snake_case` database columns to camel-cased TypeScript fields. Server imports use `.js` extensions for ESM. No formatter or linter is configured, so preserve surrounding style.

## Testing Guidelines

There is no automated test framework or coverage threshold. Run the web build and server type-check, then manually exercise affected API/UI flows. New tests should use `*.test.ts` or `*.test.tsx`; add the runner and `npm test` script to the relevant package. Never write tests against the default `~/.workbench` database.

## Commit & Pull Request Guidelines

History uses Conventional Commit-style subjects, for example `feat: ...`. Write an imperative summary such as `fix: prevent duplicate RSS items` and keep commits focused. Pull requests should explain the change, list verification commands, link issues, and include screenshots for UI changes. Call out schema, configuration, or dependency changes.

## Configuration & Data Safety

Use `WORKBENCH_HOME` to isolate local or test data, `WORKBENCH_PORT` to change the API port, and `WORKBENCH_THINKING` to tune agent reasoning. Never commit `.env` files, credentials, SQLite files, or agent output containing sensitive feed content.
