# Independent review — Phase 1 scaffold

One independent pass, against the six acceptance criteria. No blockers.
Dispositions below; everything marked *fixed* was re-verified, not assumed.

## Major

| # | Finding | Disposition |
|---|---|---|
| 1 | `export:all` ran `expo export` twice; the second run deletes `dist/` first, so only Android survived. Acceptance criterion 2 was not actually met, and `verification.md` claimed both platforms. | **Fixed** — one invocation, `--platform ios --platform android`. Re-run: `metadata.json` now lists both, both `.hbc` files present. |
| 2 | `options.manual` as a string (or `dropped` as a number) threw out of the quote handler, returning a 500 outside the `Result` envelope. | **Fixed** — inputs coerced, handler wrapped, `internal` reason used for genuine failures. Both payloads now return a proper envelope. |
| 3 | `miles: "twelve"` produced `incomplete: false` with the mileage line silently absent — a quote reporting itself safe to invoice while missing its distance. | **Fixed** — non-numeric, non-finite and negative mileage rejected with `validation`. This inverted non-negotiable #4 and was the most serious finding. |
| 4 | `Result<T>` / `FailureReason` were not reachable from the apps, so nothing compile-checked the envelope. | **Fixed** — `./api` added to the package `exports`; the route is now typed against `Result<QuoteData>`. |
| 5 | Build-before-apps ordering was documented but unenforced; `bun install && bun run typecheck` failed on a fresh clone with a misleading "cannot find module". | **Fixed** — `prepare` on the rules package. Verified by deleting `dist/` and reinstalling. |
| 6 | The repo is public and `packages/rules/legacy/` carries live production identifiers: the driver-app `/exec` deployment URL, seven spreadsheet IDs, and company email addresses. | **Escalated to the owner.** Not a code defect — a decision, and irreversible once pushed. Blocking the first push. |

## Minor

Fixed: verification wording corrected (1, 2); Bun pinned to 1.3.11 and
`actions/setup-node@v4` added (3, 4); root `typecheck` now covers `@ag/rules`
(5); `db:up`/`db:smoke` take `-d "${PGDATABASE:-agnext}"` (6); `{"trip": []}`
rejected (7); app renamed off the `create-expo-app` default with real bundle
identifiers (8); `typescript` declared on the rules package (9).

## Optional — recorded, not actioned

- `verify` compiles the package three times and CI four. Correct but wasteful.
- CI triggers on pushes to `main` only; feature branches wait for a PR.
- `apps/mobile/` keeps `CLAUDE.md`, `AGENTS.md` and `.claude/settings.json` from
  the Expo template. The `AGENTS.md` pointer to versioned Expo docs is useful;
  the committed `enabledPlugins` is one developer's preference. (The template's
  `LICENSE`, which asserted Expo's copyright over this app, was removed.)
- No `main`/`types` fallback beside `exports` — fine for both current
  consumers, a trap for classic node10 resolution later.
