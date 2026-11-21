# Secret Santa

A tiny static Secret Santa app. One person enters the names, gets a private link per participant,
and sends each person only their own. Opening the link reveals who you're buying for.

No server, no accounts, no database — plain HTML/JS on GitHub Pages.

## How it works

| File | Job |
|---|---|
| `src/assign.js` | Backtracking derangement: nobody draws themselves, excluded pairs never draw each other |
| `src/crypto.js` | AES-GCM; the key and ciphertext both live in the URL **fragment** |
| `src/ui.js` | The two views: organiser form, and reveal |
| `index.html` | Markup + styling |
| `tests/` | `node --test` — assignment and crypto round-trip |

## Privacy model (honest version)

- **The link is the secret.** It contains that one assignment, encrypted. Whoever holds it can read it.
- **The host never sees it.** URL fragments aren't sent to servers, so GitHub Pages can't log matches.
- **Nothing is stored.** No cookies, no localStorage, no backend. Close the tab and it's gone.
- **Generated in the browser.** Assignments are computed locally, never uploaded.

If a link leaks, regenerate the set — there's nothing to revoke because nothing is persisted.

## Run it locally

ES modules need a real HTTP server (not `file://`):

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## Tests

```bash
npm test
```

## Deploy

Push to `master`. GitHub Pages serves the repository root — no build step.
