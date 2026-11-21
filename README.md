# Secret Santa 🎄

A cozy Secret Santa for friends who only know each other online. No addresses, no emails.
Everyone signs up with one shared link, names get drawn privately, and gifts are **digital**
(gift cards, codes) or **handmade** (drawings, notes), with a **$20** limit.

## How it works for the group

1. **Start a group.** Pick a name and a gift day, then add your own name and wishlist.
2. **Share the join link.** Each friend opens it and writes their own name, wishlist, and
   whether they'd like something handmade, digital, or either.
3. **Save your private link.** Everyone gets one when they join. It's their way back in and
   the only key to their match and gifts. There's no password, so it can't be recovered if lost.
4. **Draw names.** Once everyone's in, the person who started the group taps *Draw names*.
   Nobody can join after that, and nobody ever sees the full list of pairs.
5. **Open your envelope** to see who you're gifting, plus their wishlist.
6. **Send your gift** in the app: a gift-card code or redeem link, a drawing (upload it), or a
   note. It's anonymous unless you sign it, and it stays wrapped until gift day.
7. **On gift day** everyone unwraps. The giver sees "Opened ✓".

## Privacy, honestly

- **No addresses or emails** are asked for or stored anywhere.
- **Your private key never leaves your device.** When you join, your browser makes a keypair. The
  public half is uploaded; the private half lives only in your private link (after the `#`,
  which browsers never send to servers).
- **Matches and gifts are sealed in the browser** to the reader's public key. The database
  only ever holds ciphertext, so even someone browsing the Supabase dashboard can't read who drew
  whom or see a gift-card code.
- **Gifts don't record who sent them.** Only a tag that the sender's own link can recognise.
- **The draw runs in the organiser's browser.** The pairs exist in memory for a moment, are
  never shown, and only sealed envelopes are uploaded. (Someone determined could pause their
  own browser with dev tools to peek during the draw. It's a game among friends.)
- **The $20 limit is an honour rule.** The app warns if a gift card is over $20.

## Setting up Supabase (one time, about 5 minutes)

Until this is done the app runs in **demo mode**, which saves everything in one browser. That's
handy for trying it out, but links won't work on anyone else's device.

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and press
   **Run**. (It's safe to run again later.)
3. Open **Project Settings → API Keys** and copy the **Project URL** and the **publishable key**
   (`sb_publishable_…`; older projects call it the `anon` public key).
4. Put them in [`src/config.js`](src/config.js) and push. Both are safe to publish.
   **Never** put the secret / `service_role` key in this repo.

The website can only call the `santa_*` functions in that file. The tables sit in a private
`santa` schema with row-level security on and no grants, so the publishable key can't read
them directly.

## Files

| File | Job |
|---|---|
| `index.html` | All markup and styling (cozy Christmas theme, fonts in `fonts/`) |
| `src/ui.js` | The screens: start, join, my page (lobby, envelope, send gift, under your tree) |
| `src/santa.js` | The flows: create/join, load my page, draw names, send gifts |
| `src/keys.js` | Sealed envelopes (ECDH P-256 + AES-GCM, Web Crypto) and private links |
| `src/db.js` | Supabase calls, plus a demo backend with the same rules |
| `src/config.js` | Supabase URL + publishable key (empty = demo mode) |
| `src/assign.js` | Pairing: nobody draws themselves |
| `src/crypto.js` | Base64 helpers (and the original link-only encryption) |
| `supabase/schema.sql` | Tables, security rules and the API functions |

## Run it locally

ES modules need a real HTTP server (not `file://`):

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## Tests

```bash
node --test tests/*.test.js
```

Pairing, encryption, and the full five-person flow on the demo backend.

The database tests run the real SQL in an in-memory Postgres:

```bash
npm i --no-save @electric-sql/pglite
node --test supabase/tests/*.test.mjs
```

## Deploy

Push to `master`. GitHub Pages serves the repository root, with no build step.
