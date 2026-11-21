# Working rules — shared workspace

This project is edited by **two people and two AI agents at the same time**. Read this before touching anything.

## Before you edit

1. Call `view_changes` to see what the other agent changed recently.
2. Call `lock_file` on the file(s) you're about to change.
3. Read the file with `read_file` before modifying it.

## While editing

- Change one thing per edit. Small diffs, no drive-by reformatting.
- Do not edit files outside the area assigned to you in `PLAN.md`. Ask first.
- If a file is already locked by someone else, work on a different file — don't wait on it.

## After editing

1. Call `unlock_file` so the other agent can take it.
2. Run the project's checks and report the real output.
3. Commit before starting something new.

## Never

- Never force-touch a locked file.
- Never rewrite a file you haven't read this session.
- Never run `git reset --hard`, `git checkout --`, or `git push --force`.
- Never "fix forward" a broken change — use `rollback_file` or ask.

## Git

Two people push to the same `master`. Keep it boring:

1. **`git pull --rebase` before you start** and before you push.
2. Commit small and often, with a message that says *why*.
3. Never `git push --force`, never rewrite history, never `git reset --hard`.
4. If a rebase conflicts in a file you don't own, stop and ask rather than choosing sides.
5. `node_modules/` and `.opencoop/` stay out of the repo (they're in `.gitignore`).

GitHub Pages deploys `master` — a broken commit there is a broken app for everyone.

## Checks

| Stack | Command |
|---|---|
| Python | `python -m pytest -q` · `ruff check .` |
| JS/TS | `npx tsc --noEmit` · `npm test -- --run` |

If a check doesn't exist yet, say so instead of claiming the change works.

## Coordination

The humans talk outside this workspace. Assume the other agent is working **right now** — if your change touches their files, say so in your reply rather than guessing at a merge.
