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

test("lost-link recovery through the Supabase client and the real SQL", async () => {
  const made = await S.createGroup(api, { title: "Recovery pals", giftDay: "", name: "Don", wishlist: "", giftPref: "either" });
  const secrets = [parsePrivateFragment(made.fragment)];
  for (const n of ["Mia", "Kai", "Rin", "Sol"]) {
    secrets.push(parsePrivateFragment((await S.joinGroup(api, made.code, { name: n, wishlist: "", giftPref: "either" })).fragment));
  }
  await S.drawNames(api, secrets[0]);
  const kaiTarget = (await S.loadMe(api, secrets[2])).match.name;
  const req = await S.requestNewLink(api, made.code, "Kai");
  const kai = parsePrivateFragment(req.fragment);
  assert.equal((await api.linkStatus(kai.token)).status, "pending");
  const kaiId = (await S.loadMe(api, secrets[0])).participants.find((p) => p.name === "Kai").id;
  await api.approveNewLink(secrets[0].token, kaiId, true);
  for (const i of [0, 1, 3, 4]) await S.loadMe(api, secrets[i]);
  const k = await S.loadMe(api, kai);
  assert.equal(k.match.name, kaiTarget);
  assert.equal(k.recovery, null);
});

test("two lost links at once through the Supabase client and the real SQL", async () => {
  for (let run = 0; run < 6; run++) {
    const names = ["appleknife", "coco", "sho", "deli", "yumeko"];
    const made = await S.createGroup(api, { title: `Pals ${run}`, giftDay: "", name: names[0], wishlist: "", giftPref: "either" });
    const secrets = [parsePrivateFragment(made.fragment)];
    for (const n of names.slice(1)) {
      secrets.push(parsePrivateFragment((await S.joinGroup(api, made.code, { name: n, wishlist: "", giftPref: "either" })).fragment));
    }
    await S.drawNames(api, secrets[0]);
    const before = [];
    for (const s of secrets) before.push((await S.loadMe(api, s)).match.name);

    for (const i of [2, 3]) secrets[i] = parsePrivateFragment((await S.requestNewLink(api, made.code, names[i])).fragment);
    const ps = (await S.loadMe(api, secrets[0])).participants;
    for (const i of [2, 3]) await api.approveNewLink(secrets[0].token, ps[i].id, true);
    const sho = await api.myEvent(secrets[2].token);
    assert.equal(sho.recovery.needed, 3, "only the three who kept their links are needed");

    for (const i of [4, 2, 1, 3, 0, 2, 3]) await S.loadMe(api, secrets[i]);
    const after = [];
    for (const s of secrets) {
      const m = await S.loadMe(api, s);
      assert.ok(m.match && m.match.name);
      after.push(m.match.name);
    }
    for (const i of [0, 1, 4]) assert.equal(after[i], before[i]);
    after.forEach((t, i) => assert.notEqual(t, names[i]));
    assert.deepEqual([...after].sort(), [...names].sort());
  }
});
