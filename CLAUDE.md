# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A CLI (`github-artifacts`) that walks a user's GitHub repositories, tallies GitHub Actions artifact storage, and offers interactive deletion. TypeScript source in `src/`, compiled to `dist/` — `dist/` is gitignored, so **nothing runs until you build**.

## Commands

```bash
npm install
npm run build                  # tsc -> dist/
npx tsc --watch                # rebuild on change
npm run dev                    # build + run (no args)
npm start -- analyze --top 5   # run built CLI with args (note the `--`)
npm run analyze                # build + `analyze`
npm run cleanup                # build + `analyze --cleanup` (interactive deletes)
npm run example                # ./examples.sh — runs a full live-API tour, needs GITHUB_TOKEN
```

`npm test` and `npm run lint` are stubs — there is no test suite and no linter configured. Do not claim tests pass; verify changes by running the CLI against a real repo:

```bash
export GITHUB_TOKEN=$(gh auth token)
npm start -- repo <owner> <repo>
npm start -- analyze --username <user> --top 3
```

Token is read from `--token`, then `GITHUB_TOKEN`, then a `.env` file (loaded via `dotenv.config()` in `src/index.ts`). Needs `repo`, `read:user`, `actions:read`. Deletion additionally needs write access.

Note: `README.md` documents `npm run clean`, which does not exist in `package.json`. Use `rm -rf dist && npm run build`.

## Architecture

Three files, one direction of dependency: `index.ts` → `analyzer.ts` (fetch) → `reporter.ts` (present).

- **`src/index.ts`** — Commander CLI. Two commands, `analyze` (all repos) and `repo <owner> <repo>` (one). Both branch at the end on `--cleanup`: report vs. interactive delete.
- **`src/analyzer.ts`** — `GitHubArtifactsAnalyzer`, the only Octokit consumer. Also owns `deleteArtifact()` and `sleep()`, which `reporter.ts` calls back into during cleanup.
- **`src/reporter.ts`** — `ReportGenerator`. Table/JSON/CSV rendering plus the readline-driven cleanup prompts.

### The analysis object is the contract

There are no interfaces or type declarations. The shape produced by `analyzer.analyzeRepository()` (`src/analyzer.ts:130`) is consumed structurally everywhere else, and `analyzeAllRepositories()` wraps a list of these in `{ repositories, summary }`. `tsconfig.json` sets `strict: false` and most parameters are untyped, so **the compiler will not catch a renamed or dropped field** — adding or changing one means hand-checking `calculateSummary()`, every `generate*Report()`, and both cleanup paths.

This shared shape is deliberate: `reporter.runRepositoryCleanup()` is called both with a single-repo analysis (from the `repo` command) and per-element from `runCleanupMode()` (from `analyze --cleanup`).

### Artifact discovery uses the repo-wide endpoint

`analyzeRepository()` enumerates artifacts via `octokit.paginate(actions.listArtifactsForRepo)` — one paginated sweep per repo, plus one `listRepoWorkflows` call kept only to populate the workflow *count* in reports. Roughly 2 requests for a typical repo; a 118-repo account scan measured at 246 calls / 70 s.

It previously walked workflows → up to 100 runs each → each run's artifacts, which was O(workflows × runs), silently truncated at the 100-run cap, and made a full-account `analyze` impossible (measured ~892 calls for under 2 repos against a 5,000/hr limit). Do not reintroduce that shape.

The trade-off: `/actions/artifacts` carries `workflow_run.{id, head_branch, head_sha}` but **not** the workflow name. So:

- `workflowName` is `null` by default; `headBranch` is always populated.
- `reporter.workflowLabel()` falls back `workflowName → headBranch → 'Unknown'`, and the column is headed "Workflow / Branch".
- `--resolve-workflows` opts into `resolveWorkflowNames()`, costing one request per *distinct run* (not per artifact). It maps `run.workflow_id` through the already-fetched workflow list to get the true workflow name — `run.name` alone is the run's display title (e.g. "Push on main"), not the workflow name.

`analyzeAllRepositories()` still iterates repos serially with a fixed `sleep(100)`. There is still no rate-limit-header inspection, backoff, or retry — the "intelligent throttling" in the README is that sleep plus a 250 ms one between deletes.

### Known sharp edges

All three are confirmed by reproduction and tracked as issues on this fork.

- **The globally installed CLI does nothing** ([#1](https://github.com/johnybradshaw/github-artifacts-analyzer/issues/1)). `src/index.ts:116` gates `program.parse()` on `import.meta.url === \`file://${process.argv[1]}\``. `npm install -g` invokes through a bin symlink, so `argv[1]` is the symlink path while `import.meta.url` is the realpath — they never match and the process exits 0 with no output. Only `node dist/index.js` works, which is why it is invisible in development. Also breaks on Windows and on paths needing URL escaping. Same defect as upstream #6/#7.
- **`analyze --username <other-user>` silently returns zeros** ([#2](https://github.com/johnybradshaw/github-artifacts-analyzer/issues/2)). It paginates `repos.listForAuthenticatedUser` — which only ever returns the token holder's repos — then filters `repo.owner.login === username` (`src/analyzer.ts:41`), so a foreign username matches nothing. `analyzePublicRepositories()` would handle it correctly but is only reachable from the 401/403 catch (`src/analyzer.ts:66`). The README's own example uses this flag.
- **`formatBytes()` is duplicated and loses its unit at >= 1 TiB** ([#3](https://github.com/johnybradshaw/github-artifacts-analyzer/issues/3)). Byte-identical copies at `src/analyzer.ts:251` and `src/reporter.ts:287`; the `sizes` table stops at `GB`, so a terabyte renders as `1 undefined`. The `bytes` package is declared in `package.json` but never imported anywhere in `src/`.

- **`analyzeRepository()` used to under-report** ([#4](https://github.com/johnybradshaw/github-artifacts-analyzer/issues/4)) — fixed on `fix/paginated-artifacts-endpoint`. `kubectm` reported 109 of its 130 artifacts before the change, 130 after.

One more, not filed because it is correct today: pagination in `analyzeAllRepositories` only advances `page` inside the non-empty branch. It works, but the loop is easy to break when editing.

## Conventions that matter here

- **ESM everywhere.** `"type": "module"` plus `module: ESNext` / `moduleResolution: node`. Relative imports in `.ts` source must carry the **`.js`** extension (`import { GitHubArtifactsAnalyzer } from './analyzer.js'`). Omitting it compiles but fails at runtime.
- `formatBytes()` is duplicated verbatim in `analyzer.ts` and `reporter.ts`. If you change one, change both, or extract it — see [#3](https://github.com/johnybradshaw/github-artifacts-analyzer/issues/3).
- Output is heavily chalk/emoji-formatted and written straight to `console.log`. `ora` spinners in `index.ts` must be `succeed()`/`fail()`-ed before any other output, or the terminal is left mid-spinner.
- Publishing: `.npmignore` ships `dist/` only; `prepublishOnly` runs the build. Never commit `dist/`.
