# PLAN — Secret Santa

## The app (agreed direction, Nov 2026)

A festive, no-address Secret Santa app. The organiser creates an event and shares one join link.
People sign up themselves, list what they'd like, and the app pairs everyone randomly and privately.
Gifts are **handmade/drawn** or **digital** (gift cards / codes) — there are no shipping addresses
and no email addresses anywhere in the system. One fixed cap: **$20 max**.

**Stack:** static HTML/CSS/ES modules on GitHub Pages + Supabase (free tier) as the backend ·
`node --test` for tests. No server to host; the anon key is public by design, protected by RLS.

## Architecture

- **Supabase** holds three tables: `events`, `participants`, `assignments` (see `supabase/schema.sql`).
- **No emails, no addresses.** On signup the browser generates an RSA keypair. The **public** key is
  uploaded; the **private** key stays only in that person's private return link (URL fragment), which
  they save. The link is the secret; nothing is emailed.
- **Draw:** the organiser clicks Draw. The browser fetches participants, runs a derangement
  (no self-draw, exclusions respected), encrypts each giver's payload with **that giver's public key**,
  and uploads only ciphertexts. The UI never displays pairs and the DB never holds plaintext.
- **Reveal:** each person opens their private link, fetches their ciphertext by token hash, and
  decrypts with their private key. They see their match, the $20 cap, and the match's wishlist.
- **Digital gifting:** wishlist items are tagged `handmade` or `digital gift card` (brand + amount).
  A giver can paste a gift-card code into their own reveal view; it is encrypted to the recipient's
  public key and stored, so only the recipient can read it. A "delivered" checkbox tracks progress.
- **Hardening (later):** move the draw into a Supabase Edge Function so the organiser's browser never
  sees the mapping at all. Not required for v1.

## Status (Nov 21, 2026)

Steps 1–8 are built; only the live Supabase project is left (step 1). Changes from the plan above:

- **Keys:** ECDH P-256 instead of RSA. It does the same job with much shorter private links
  (`src/keys.js`, new file; `src/crypto.js` and `src/assign.js` are reused unchanged).
- **Access:** no RLS policies for the website at all. The tables are in a private `santa` schema,
  and the website only calls token-checked `santa_*` functions.
- **Gifts:** stored with a sender *tag* instead of a giver id, wrapped until gift day (enforced by
  the database), and the giver sees "Opened ✓" instead of a manual "delivered" checkbox.
- **Demo mode:** with `src/config.js` empty, the same rules run in `localStorage`, so the app
  works before Supabase is set up.
- **Not done (fine for a group of 5):** "can't draw each other" exclusions, join deadline, and
  Edge Function hardening.

## Division of work

Split by **files**. The remote member owns the logic; Appleknife owns the interface and data layer.

| Area | Owner | Files |
|---|---|---|
| Assignment algorithm + crypto | member | `src/assign.js`, `src/crypto.js`, `tests/assign.test.js`, `tests/crypto.test.js` |
| Interface + Supabase data layer | Appleknife | `index.html`, `src/ui.js`, `src/db.js`, `src/config.js` |
| Database schema | Appleknife (proposed, confirm with member) | `supabase/schema.sql` |
| Shared config | both — ask first | `package.json`, `README.md`, `PLAN.md`, `AGENTS.md` |

## Build order

1. **Supabase project** — Appleknife creates it, runs `supabase/schema.sql`, enables RLS, and puts the
   project URL + anon key in `src/config.js` (placeholder until supplied). Never commit a service key.
2. **Schema + data layer** — `supabase/schema.sql`, `src/db.js`: create event, join event, fetch
   participants, upload/download ciphertexts, close draw.
3. **Event + signup UI** — organiser form (title, $20 cap, join deadline, exchange date, exclusions),
   shareable join link, signup form (name, handmade/digital preference, wishlist), private-link handout.
4. **Crypto upgrade (member)** — RSA keypair generation, encrypt/decrypt payloads, extend tests.
5. **Draw + reveal** — wire `assign.js` + `crypto.js` + `db.js`; encrypt-to-public-key flow; no
   plaintext written anywhere.
6. **Gifting UX** — wishlist tags, gift-card code field (encrypted to recipient), delivered checkbox,
   gentle over-$20 nudge, invite text that says "no addresses, digital or handmade only".
7. **Festive visual pass** — deep green / cranberry / gold palette, gentle snowfall, rounded cards,
   playful heading font, envelope-open reveal, mobile-first. Use CSS/SVG decorations for v1; ask before
   running the local art pipeline for illustrations (it uses the GPU).
8. **Verify + ship** — `npm test`, walk a 3-person flow over HTTP, commit and push (Pages deploys master).

## Definition of done

`npm test` passes; a 3-person signup → draw → reveal works over HTTP; no address/email fields exist;
no plaintext assignment is stored; the change is committed and pushed.

## Notes / risks

- Supabase anon key is public by design — RLS must keep participants from reading each other's rows
  and from writing to closed events.
- Organiser's browser sees the mapping in memory during the draw in v1; Edge Function hardening later.
- The member must be connected in OpenCOOP for live co-editing (currently offline).
