# PLAN — Secret Santa

## The app

Enter participants (and optional "can't draw each other" pairs), get one private link per person.
Each person opens their own link and sees who they're buying for. Static site, no backend.

**Stack:** vanilla HTML/CSS/ES modules · GitHub Pages · `node --test` for tests.

## Division of work

Split by **files**. The remote member owns the logic; Appleknife owns the interface.

| Area | Owner | Files |
|---|---|---|
| Assignment algorithm | member | `src/assign.js`, `tests/assign.test.js` |
| Encrypted links | member | `src/crypto.js`, `tests/crypto.test.js` |
| Interface, styling, UX | Appleknife | `index.html`, `src/ui.js` |
| Shared config | both — ask first | `package.json`, `README.md`, `PLAN.md`, `AGENTS.md` |

## Current task

- [x] Scaffold: working assignment + crypto + UI + tests (13 passing)
- [ ] Agree on the first feature to add (pick one below)
- [ ] Build it
- [ ] Verify on the live Pages URL

## Ideas, pick one at a time

1. **Wishlists** — each participant adds a note ("books, size M, no chocolate") that appears on the
   organiser's list, encrypted with their own link.
2. **Result download** — organiser downloads a CSV of name → link, so a refresh doesn't lose them.
3. **Copy-all** — a single "copy all links" button plus a warning, for people who just DM everyone.
4. **Mobile polish** — the reveal screen on a phone; large type, one tap to copy.

## Definition of done

`npm test` passes, the page works when opened over HTTP, and the change is committed and pushed.
