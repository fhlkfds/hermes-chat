# hermes-chat

Personal Tauri 2 + React + TypeScript desktop chat client for a remote Hermes Agent, built for Arch Linux.

## Package manager

The frontend uses **pnpm** (`packageManager` in `package.json`, lockfile `pnpm-lock.yaml`). Run `pnpm install`, `pnpm test`, `pnpm run build`. Never run `npm install` or commit a `package-lock.json`; worktrees share one pnpm store so each checkout's `node_modules` costs almost no disk.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `l0cky12/hermes-chat`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.



### Codex review loop

For large changes (new feature, multi-file refactor, new Rust/TS module, or anything touching `src-tauri` network/auth code):

1. **Claude codes it.** Claude Code implements the change, builds, and runs the tests.
2. **Codex reviews.** Run a review with Codex CLI, model `gpt-6.1`, reasoning effort `high`:

   ```
   CODEX_HOME=/home/liam/.codex codex exec -m gpt-6.1 -c model_reasoning_effort=high \
     --sandbox read-only 'Review the uncommitted changes (git diff). Report bugs, logic errors, security issues, and missing test coverage. End with VERDICT: PASS or VERDICT: CHANGES with a numbered list of required fixes.'
   ```

3. **Loop on CHANGES.** If the verdict is `CHANGES`:
   - Send the numbered fixes back to Claude. Claude applies them, rebuilds, and reruns tests.
   - Send the updated diff back to Codex for the next review round.

4. **Round limit.** Codex gets at most **3 review rounds**. If Codex still returns `CHANGES` after the 3rd round, stop the loop: apply nothing further, label the PR or issue `ready-for-human`, and summarize the remaining fixes in the PR body.

Claude must never mark the change done while any Codex round is unresolved. Track the round count explicitly (e.g. "Codex review round 2/3") in the PR or task notes so the limit is auditable.

### PR conventions

- Reference the correct `docs/adr/` file name; verify it exists before opening the PR.
- Attach screenshots to the PR for any UI change.
- Link the issue with `Fixes #N`.
- Never report a test as passing unless you ran it. If a step can't run (no server, no UI), say exactly why instead of faking it.

### Verify before PR

Run the build and test suite after every code change, before committing. A failing build is a blocked task, not a note in the PR body.

### Merge authority

Agents open and update PRs but never merge to `main`. Merging is human-only.
