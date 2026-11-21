// Optional, needs PGlite:  npm i --no-save @electric-sql/pglite && node --test supabase/tests/*.test.mjs
// Runs the app's real flows (src/santa.js + supabaseBackend) against the real
// SQL, by routing fetch() into an in-memory Postgres shaped like PostgREST.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const ROOT = new URL("../..", import.meta.url).href.replace(/\/$/, "");
const { supabaseBackend } = await import(`${ROOT}/src/db.js`);
const { parsePrivateFragment } = await import(`${ROOT}/src/keys.js`);
const S = await import(`${ROOT}/src/santa.js`);

const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin;`);
await db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
await db.exec(`grant usage on schema public to anon, authenticated; set role anon;`);

const calls = [];
globalThis.fetch = async (url, init) => {
  assert.equal(init.headers.apikey, "sb_publishable_test");
  assert.equal(init.headers.Authorization, undefined);
  const fn = /\/rest\/v1\/rpc\/(\w+)$/.exec(url)[1];
  const args = JSON.parse(init.body);
  calls.push(fn);
  const names = Object.keys(args);
  const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
  const vals = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
  try {
    const res = await db.query(sql, vals);
    return new Response(JSON.stringify(res.rows[0].r ?? null), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ code: e.code, message: e.message }), { status: 400 });
  }
};

const api = supabaseBackend("https://example.supabase.co/", "sb_publishable_test");

test("full five-person flow through the Supabase client and the real SQL", async () => {
  const made = await S.createGroup(api, { title: "Online pals", giftDay: "2020-12-20", name: "Don", wishlist: "cat drawing", giftPref: "handmade" });
  const secrets = [parsePrivateFragment(made.fragment)];
  const prev = await api.eventPreview(made.code);
  assert.equal(prev.title, "Online pals");
  for (const n of ["Mia", "Kai", "Rin", "Sol"]) {
    secrets.push(parsePrivateFragment((await S.joinGroup(api, made.code, { name: n, wishlist: "games", giftPref: "digital" })).fragment));
  }
  await assert.rejects(() => S.joinGroup(api, made.code, { name: "MIA", wishlist: "", giftPref: "x" }), /already uses that name/);

  await api.updateMe(secrets[2].token, "cozy socks", "either");
  await S.drawNames(api, secrets[0]);

  const seen = [];
  for (const s of secrets) {
    const me = await S.loadMe(api, s);
    assert.ok(me.match.name && me.match.name !== me.me.name);
    seen.push(me.match.name);
  }
  assert.deepEqual(seen.sort(), ["Don", "Kai", "Mia", "Rin", "Sol"]);

  const don = await S.loadMe(api, secrets[0]);
  const ri = don.participants.findIndex((p) => p.id === don.match.id);
  const gid = await S.sendGift(api, secrets[0], don.match, { kind: "art", image: "data:image/png;base64,AAAA", message: "made this for you" });
  assert.match(gid, /^[0-9a-f-]{36}$/);

  // gift day 2020 is in the past -> open
  const them = await S.loadMe(api, secrets[ri]);
  assert.equal(them.received[0].gift.message, "made this for you");
  await api.openGift(secrets[ri].token, them.received[0].id);
  assert.ok((await S.loadMe(api, secrets[0])).sent[0].opened_at);
  await assert.rejects(() => api.unsendGift(secrets[0].token, gid), /can't be taken back/);
  await assert.rejects(() => api.myEvent("x".repeat(30)), /not valid/);
});

test("a raw Postgres error is not leaked to the page", async () => {
  await assert.rejects(() => api.sendGift("y".repeat(30), "not-a-uuid", "z".repeat(30)), /Something went wrong/);
});
