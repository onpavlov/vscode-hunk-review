# AGENTS.md

VS Code extension "hunk-review" — code review integrated with hunk.dev. Currently at scaffold stage: only the generated `helloWorld` command exists in `src/extension.ts`; everything else is stock VS Code extension tooling.

## Commands

- `npm run compile` — typecheck + lint + bundle to `dist/extension.js` (esbuild, CJS)
- `npm run watch` — parallel esbuild + tsc watch
- `npm run package` — production build (minified, no sourcemaps)
- `npm run check-types` / `npm run lint` (eslint on `src`) — run individually
- `npm test` — runs `vscode-test`, but first executes `pretest`, which compiles tests with `tsc -p . --outDir out` AND runs the full compile+lint. Tests live in `src/test/`, compiled to `out/`, discovered via `.vscode-test.mjs` (`out/test/**/*.test.js`). Note: running a single test file is not configured; the test runner launches a real VS Code instance.
- Debug: F5 in VS Code uses `.vscode/launch.json` (Extension Development Host), `.vscode/tasks.json` wires up watch.

## Architecture

- Entry point: `src/extension.ts` — `activate()` registers commands. Bundle output `dist/extension.js` is what `package.json` `main` points to.
- New user-facing commands must be declared twice: `contributes.commands` in `package.json` AND `vscode.commands.registerCommand` in code (IDs must match, prefixed `hunk-review.`). `activationEvents` is empty because command-based activation is implicit.
- esbuild bundles everything except `vscode` (external). Don't rely on runtime require of node deps without checking bundling.

## Conventions

- TypeScript strict mode, `module: Node16`, target ES2022, rootDir `src`.
- ESLint only covers `src` (run via npm scripts, not bare eslint).
- Tab indentation in `src/extension.ts` (default VS Code style).
- `package.json` uses `overrides` for `diff` and `serialize-javascript` — preserve these when editing dependencies.

## Gotchas

- `npm test` is heavy: it compiles twice (tests + extension) and launches an Electron VS Code instance; on failure check that `out/` was regenerated.
- The repo has no git-tracked files yet (everything untracked on `master`) — don't assume prior history.
- This is a generated scaffold (see `vsc-extension-quickstart.md`); the "hello world" command is placeholder code, not a feature.
