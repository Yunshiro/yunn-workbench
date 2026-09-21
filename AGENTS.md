# AGENTS.md

## Repository Overview

Yunn Workbench is a local-first content research application distributed as an npm CLI. It combines RSS ingestion, a SQLite-backed Express API, a Pi-powered AI task queue, and a React/Vite UI. The supported runtime is Node.js 24 or newer because the server uses `node:sqlite`.

The normal data flow is:

```text
React UI -> REST API / SSE -> Express -> SQLite
                                      -> RSS feeds
                                      -> Pi agent / configured model provider
```

The application has no authentication layer and is designed to listen on the loopback interface. Do not make it publicly reachable without adding an explicit security model.

## Repository Layout

- `cli/yworkbench.js`: published `yworkbench` executable. It validates CLI arguments, sets runtime environment variables, imports the built server, and opens the browser.
- `server/src/index.ts`: server lifecycle, static web hosting, scheduled RSS refresh, and retention cleanup.
- `server/src/http.ts`: all `/api` routes, request validation, error responses, and SSE broadcasting.
- `server/src/db.ts`: SQLite schema, forward migrations, row mappers, and persistence functions.
- `server/src/rss.ts`: RSS probing, fetching, normalization, and item ingestion.
- `server/src/agent.ts`: in-process task queue, Pi sessions, research conversations, task state transitions, and emitted events.
- `server/src/agent-auth.ts`: model profiles, provider credentials, active-model selection, and connection tests.
- `server/src/prompts.ts`: editable prompt templates and task prompt construction.
- `server/src/structured-output.ts`: parsing and validation of model JSON output.
- `server/src/research-tools.ts`: local read-only tools exposed to research sessions.
- `web/src/views/`: page-level React components.
- `web/src/components/`: shared UI and feature components.
- `web/src/lib/api.ts`: browser REST client; keep it aligned with server routes.
- `web/src/lib/sse.ts`: the single global EventSource connection and supported event names.
- `web/src/lib/types.ts`: client-side API/domain types.
- `web/src/styles/global.css`: global design tokens and component styles.
- `docs/`: design and implementation notes; these are not runtime inputs.
- `server/dist/` and `web/dist/`: generated release artifacts. Never hand-edit them.

## Setup and Commands

Run commands from the repository root unless noted otherwise.

- `npm run install:all`: install root, server, and web dependencies.
- `npm run dev:server`: run the API with `tsx watch` on `127.0.0.1:3001` by default.
- `npm run dev:web`: run Vite on port `5173`; `/api` and SSE traffic are proxied to port `3001`.
- `npm run build:web`: type-check and build the React application.
- `npm run build:server`: compile `server/src` into `server/dist`.
- `npm run build`: build both packages in release order.
- `npm start`: run the CLI against built assets. This is not a source-mode command; build first.
- `cd server && npm exec -- tsc --noEmit`: quick server-only type-check.
- `node cli/yworkbench.js --help`: smoke-test CLI argument loading after a build.

For development, run the server and web commands in separate terminals. If the backend port changes, also account for the fixed Vite proxy target in `web/vite.config.ts`.

## Verification Expectations

There is currently no automated test runner or lint script. For every change, run the narrowest relevant checks and report exactly what ran.

- Server-only change: `cd server && npm exec -- tsc --noEmit`.
- Web-only change: `npm run build:web`.
- Cross-package, CLI, schema, or release change: `npm run build` and `node cli/yworkbench.js --help`.
- API or UI behavior change: manually exercise the affected flow in addition to compiling it.
- SSE or agent-task change: verify initial REST state and subsequent live event updates; the UI relies on both.

If tests are introduced, use `*.test.ts` or `*.test.tsx`, add an explicit `npm test` script to the owning package, and never point tests at the user's default data directory.

## Coding Conventions

- Use strict TypeScript, ES modules, two-space indentation, double quotes, semicolons, and trailing commas where the surrounding code uses them.
- Use `PascalCase` for React components and exported types, `camelCase` for functions and variables, and descriptive `UPPER_SNAKE_CASE` for constants.
- Preserve the existing BEM-like CSS naming style, such as `nav__item--active`.
- Server-side relative imports must include the `.js` extension so emitted ESM runs correctly.
- Prefer small functions and existing local patterns over new abstractions or dependencies.
- No formatter or linter is configured. Avoid unrelated formatting churn.
- User-facing text is primarily Chinese; match the language and tone of the surrounding UI.
- Do not edit generated files, `*.tsbuildinfo`, or lockfiles unless the corresponding source or dependency change requires it.

## Cross-Layer Change Rules

### REST API and shared data

When adding or changing an endpoint, update all affected layers together:

1. Validate and normalize input in `server/src/http.ts`.
2. Put persistence logic in `server/src/db.ts` rather than embedding SQL in routes.
3. Update `web/src/lib/types.ts` for response or domain shape changes.
4. Update `web/src/lib/api.ts` and its callers.
5. Preserve `/api` as the route prefix and return JSON errors in the existing `{ error: string }` shape.

The server and web packages do not share a generated schema, so compile-time success in one package does not prove the other side is synchronized.

### SQLite schema and migrations

`server/src/db.ts` initializes the database at module load using synchronous `node:sqlite`. Schema changes must be backward-compatible with existing `~/.workbench/workbench.db` files.

- Add new schema to the `CREATE TABLE IF NOT EXISTS` block and add an idempotent forward migration for existing databases.
- Prefer additive migrations. Do not drop or rewrite user tables without an explicit migration and recovery plan.
- Keep database columns in `snake_case` and map them to camel-cased TypeScript fields in row-mapper functions.
- Preserve foreign-key behavior, JSON serialization conventions, and relevant indexes.
- Test schema work with a temporary `WORKBENCH_HOME`; never use or delete the real `~/.workbench` database.

Because config paths are resolved during module import, set `WORKBENCH_HOME` before starting or importing the server.

### Agent tasks, prompts, and structured output

The task queue is in memory and processes jobs sequentially, while task records and research sessions are persisted. Preserve valid task transitions across `queued`, `running`, `awaiting_feedback`, `done`, `completed`, `error`, and `cancelled`.

Changes to a task output contract usually require coordinated edits to:

- prompt contracts and defaults in `server/src/prompts.ts`;
- validation/repair logic in `server/src/structured-output.ts`;
- persistence or task flow in `server/src/agent.ts`;
- client types and rendering in `web/src/lib/types.ts` and the relevant component.

Research tools should remain bounded and read-only unless the product flow explicitly requires mutation. Dispose sessions, support cancellation, and persist status/error updates on every terminal path. Never expose API keys, auth files, or unnecessary private feed content in logs or SSE payloads; keep existing thinking-stream payloads scoped to the active task UI.

### SSE events

Agent events originate in `server/src/agent.ts`, are forwarded in `server/src/http.ts`, and are registered in `web/src/lib/sse.ts`. When adding or renaming an event, update all three locations plus every listener. Event payloads should be JSON-serializable and include the relevant `taskId` for task-scoped updates.

### CLI and packaging

The CLI imports `server/dist/index.js`, and the root package publishes only `cli/`, `server/dist/`, `web/dist/`, and `README.md`. When changing runtime entry points or packaged files:

- keep the root `package.json` `files` list and build scripts aligned;
- verify behavior from built artifacts, not only through `tsx` or Vite;
- keep CLI hosting bound to `127.0.0.1` by default;
- preserve clean shutdown of timers and HTTP connections;
- check `npm pack --dry-run` for packaging changes.

## Data, Credentials, and Network Safety

Runtime data defaults to `~/.workbench` and includes the SQLite database, model profiles, credentials, prompt overrides, and Pi session files. Treat all of it as private user data.

- Use a temporary directory through `WORKBENCH_HOME` for manual tests and scripts.
- Never commit `.env` files, `*.db`, WAL/SHM files, credentials, session transcripts, or captured feed content.
- Preserve restrictive file permissions used for stored model credentials.
- Do not log API keys or return them from API responses; retain masked/metadata-only behavior.
- RSS URLs and model endpoints are external network inputs. Keep timeouts, error handling, and bounded payload behavior intact.
- Avoid destructive migration or cleanup behavior. Item retention is deliberate; user-authored topics, drafts, profiles, memories, and tasks must not be pruned with feed items.

Relevant environment variables are `WORKBENCH_HOME`, `WORKBENCH_PORT`, `WORKBENCH_HOST`, `WORKBENCH_WEB_DIST`, and `WORKBENCH_THINKING`, plus provider-specific API key variables documented in `README.md`.

## Git and Pull Requests

- Preserve unrelated working-tree changes and keep commits focused.
- Use Conventional Commit-style imperative subjects, for example `fix: preserve research task status`.
- Pull requests should summarize behavior, list verification commands, link relevant issues, and include screenshots for visible UI changes.
- Explicitly call out database migrations, configuration changes, dependency changes, and packaging changes.
