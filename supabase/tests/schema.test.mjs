// Optional, needs PGlite:  npm i --no-save @electric-sql/pglite && node --test supabase/tests/*.test.mjs
// Runs supabase/schema.sql in an in-memory Postgres (PGlite) and exercises the API
// as the `anon` role, the way the website's publishable key would.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const b64 = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");
const key = () => ({ kty: "EC", crv: "P-256", x: b64(32), y: b64(32), ext: true });
const tok = () => b64(24);

async function fresh() {
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin;`);
  await db.exec(SCHEMA);
  await db.exec(SCHEMA); // re-runnable
  await db.exec(`grant usage on schema public to anon, authenticated; set role anon;`);
  const rpc = async (fn, args) => {
    const names = Object.keys(args);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
    const vals = names.map((n) => (args[n] !== null && typeof args[n] === "object" ? JSON.stringify(args[n]) : args[n]));
    const res = await db.query(sql, vals);
    return res.rows[0].r;
  };
  return { db, rpc };
}

async function group(rpc, n = 5) {
  const t = [tok()];
  const made = await rpc("santa_create_event", {
    p_title: "Online pals", p_gift_day: "2026-12-20", p_name: "P0", p_wishlist: "drawings",
    p_gift_pref: "handmade", p_public_key: key(), p_token: t[0],
  });
  for (let i = 1; i < n; i++) {
    t.push(tok());
    await rpc("santa_join_event", {
      p_code: made.code, p_name: `P${i}`, p_wishlist: "", p_gift_pref: "digital",
      p_public_key: key(), p_token: t[i],
    });
  }
  return { code: made.code, t };
}

test("anon cannot read the tables directly", async () => {
  const { db } = await fresh();
  await assert.rejects(() => db.query("select * from santa.participants"));
  await assert.rejects(() => db.query("select * from santa.gifts"));
  await assert.rejects(() => db.query("select santa.hash_token('x')"));
});

test("create, join, preview, my_event", async () => {
  const { rpc } = await fresh();
  const { code, t } = await group(rpc, 5);
  const prev = await rpc("santa_event_preview", { p_code: code });
  assert.deepEqual(prev.names, ["P0", "P1", "P2", "P3", "P4"]);
  assert.equal(prev.cap_usd, 20);
  const me = await rpc("santa_my_event", { p_token: t[2] });
  assert.equal(me.me.name, "P2");
  assert.equal(me.me.is_owner, false);
  assert.equal(me.participants.length, 5);
  assert.equal(me.assignment, null);
  assert.equal((await rpc("santa_my_event", { p_token: t[0] })).me.is_owner, true);
});

test("bad token, duplicate names, private keys are refused", async () => {
  const { rpc } = await fresh();
  const { code } = await group(rpc, 3);
  await assert.rejects(() => rpc("santa_my_event", { p_token: tok() }), /not valid/);
  await assert.rejects(
    () => rpc("santa_join_event", { p_code: code, p_name: " p1 ", p_wishlist: "", p_gift_pref: "x", p_public_key: key(), p_token: tok() }),
    /already uses that name/
  );
  await assert.rejects(
    () => rpc("santa_join_event", { p_code: code, p_name: "Z", p_wishlist: "", p_gift_pref: "x", p_public_key: { ...key(), d: b64(32) }, p_token: tok() }),
    /Bad public key/
  );
});

test("only the owner can draw, rows must cover everyone, and joining closes", async () => {
  const { rpc } = await fresh();
  const { code, t } = await group(rpc, 5);
  const ps = (await rpc("santa_my_event", { p_token: t[0] })).participants;
  const rows = ps.map((p) => ({ giver_id: p.id, sealed: "x".repeat(40) }));
  await assert.rejects(() => rpc("santa_submit_draw", { p_token: t[1], p_rows: rows }), /Only the person/);
  await assert.rejects(() => rpc("santa_submit_draw", { p_token: t[0], p_rows: rows.slice(1) }), /try again/);
  await assert.rejects(() => rpc("santa_submit_draw", { p_token: t[0], p_rows: [...rows.slice(1), rows[1]] }), /try again/);
  await rpc("santa_submit_draw", { p_token: t[0], p_rows: rows });
  await assert.rejects(() => rpc("santa_submit_draw", { p_token: t[0], p_rows: rows }), /already been drawn/);
  const me = await rpc("santa_my_event", { p_token: t[3] });
  assert.equal(me.event.status, "drawn");
  assert.equal(me.assignment, "x".repeat(40));
  await assert.rejects(
    () => rpc("santa_join_event", { p_code: code, p_name: "Late", p_wishlist: "", p_gift_pref: "x", p_public_key: key(), p_token: tok() }),
    /closed/
  );
});

test("owner can remove someone before the draw", async () => {
  const { rpc } = await fresh();
  const { t } = await group(rpc, 4);
  const ps = (await rpc("santa_my_event", { p_token: t[0] })).participants;
  await assert.rejects(() => rpc("santa_remove_participant", { p_token: t[1], p_participant_id: ps[2].id }), /Only the person/);
  await rpc("santa_remove_participant", { p_token: t[0], p_participant_id: ps[2].id });
  assert.equal((await rpc("santa_my_event", { p_token: t[0] })).participants.length, 3);
  await assert.rejects(() => rpc("santa_my_event", { p_token: t[2] }), /not valid/);
});

test("gifts: sent anonymously, wrapped until gift day, opened, unsend rules", async () => {
  const { rpc, db } = await fresh();
  const { t } = await group(rpc, 3);
  const ps = (await rpc("santa_my_event", { p_token: t[0] })).participants;
  await assert.rejects(() => rpc("santa_send_gift", { p_token: t[0], p_recipient_id: ps[1].id, p_sealed: "g".repeat(30) }), /drawn yet/);
  await rpc("santa_submit_draw", { p_token: t[0], p_rows: ps.map((p) => ({ giver_id: p.id, sealed: "x".repeat(40) })) });
  await assert.rejects(() => rpc("santa_send_gift", { p_token: t[0], p_recipient_id: ps[0].id, p_sealed: "g".repeat(30) }), /isn't in your group/);
  const gid = await rpc("santa_send_gift", { p_token: t[0], p_recipient_id: ps[1].id, p_sealed: "g".repeat(30) });

  // gift day is in the future in this test, so it's wrapped
  await db.exec("reset role; update santa.events set gift_day = current_date + 30; set role anon;");
  let r = await rpc("santa_my_event", { p_token: t[1] });
  assert.equal(r.gifts_received.length, 1);
  assert.equal(r.gifts_received[0].sealed, null);
  assert.equal(r.event.gifts_open, false);

  const s = await rpc("santa_my_event", { p_token: t[0] });
  assert.equal(s.gifts_sent.length, 1);
  assert.equal(s.gifts_sent[0].recipient_id, ps[1].id);
  assert.equal((await rpc("santa_my_event", { p_token: t[2] })).gifts_sent.length, 0);

  await db.exec("reset role; update santa.events set gift_day = current_date; set role anon;");
  r = await rpc("santa_my_event", { p_token: t[1] });
  assert.equal(r.gifts_received[0].sealed, "g".repeat(30));

  await assert.rejects(() => rpc("santa_unsend_gift", { p_token: t[2], p_gift_id: gid }), /can't be taken back/);
  await rpc("santa_open_gift", { p_token: t[1], p_gift_id: gid });
  assert.ok((await rpc("santa_my_event", { p_token: t[0] })).gifts_sent[0].opened_at);
  await assert.rejects(() => rpc("santa_unsend_gift", { p_token: t[0], p_gift_id: gid }), /can't be taken back/);

  // the gifts table never stores who sent it
  await db.exec("reset role;");
  const cols = await db.query("select column_name from information_schema.columns where table_schema='santa' and table_name='gifts'");
  assert.ok(!cols.rows.some((c) => /giver|sender_id/.test(c.column_name)));
});

test("unsend before opening works", async () => {
  const { rpc } = await fresh();
  const { t } = await group(rpc, 3);
  const ps = (await rpc("santa_my_event", { p_token: t[0] })).participants;
  await rpc("santa_submit_draw", { p_token: t[0], p_rows: ps.map((p) => ({ giver_id: p.id, sealed: "x".repeat(40) })) });
  const gid = await rpc("santa_send_gift", { p_token: t[1], p_recipient_id: ps[2].id, p_sealed: "g".repeat(30) });
  await rpc("santa_unsend_gift", { p_token: t[1], p_gift_id: gid });
  assert.equal((await rpc("santa_my_event", { p_token: t[2] })).gifts_received.length, 0);
});

test("owner deletes the group; everything cascades", async () => {
  const { rpc, db } = await fresh();
  const { code, t } = await group(rpc, 3);
  const ps = (await rpc("santa_my_event", { p_token: t[0] })).participants;
  await rpc("santa_submit_draw", { p_token: t[0], p_rows: ps.map((p) => ({ giver_id: p.id, sealed: "x".repeat(40) })) });
  await rpc("santa_send_gift", { p_token: t[1], p_recipient_id: ps[2].id, p_sealed: "g".repeat(30) });
  await assert.rejects(() => rpc("santa_delete_event", { p_token: t[1] }), /Only the person/);
  await rpc("santa_delete_event", { p_token: t[0] });
  await assert.rejects(() => rpc("santa_event_preview", { p_code: code }), /could not find/);
  await assert.rejects(() => rpc("santa_my_event", { p_token: t[2] }), /not valid/);
  await db.exec("reset role;");
  for (const tbl of ["events", "participants", "assignments", "gifts"]) {
    assert.equal((await db.query(`select count(*)::int n from santa.${tbl}`)).rows[0].n, 0, tbl);
  }
});

test("lost link: request, owner approves, others vote, match restored", async () => {
  const { rpc } = await fresh();
  const { code, t } = await group(rpc, 5);
  const ps = (await rpc("santa_my_event", { p_token: t[0] })).participants;
  await rpc("santa_submit_draw", { p_token: t[0], p_rows: ps.map((p) => ({ giver_id: p.id, sealed: "x".repeat(40) })) });

  const newTok = tok();
  const newKey = key();
  await assert.rejects(() => rpc("santa_request_new_link", { p_code: code, p_name: "nobody", p_public_key: newKey, p_token: newTok }), /Nobody in this group/);
  await assert.rejects(() => rpc("santa_request_new_link", { p_code: code, p_name: "P0", p_public_key: newKey, p_token: newTok }), /co-host first/);
  const r = await rpc("santa_request_new_link", { p_code: code, p_name: "p2", p_public_key: newKey, p_token: newTok });
  assert.equal(r.owner_name, "P0");
  assert.equal((await rpc("santa_link_status", { p_token: newTok })).status, "pending");
  assert.equal((await rpc("santa_link_status", { p_token: t[1] })).status, "active");
  assert.equal((await rpc("santa_link_status", { p_token: tok() })).status, "unknown");
  await assert.rejects(() => rpc("santa_my_event", { p_token: newTok }), /not valid/);

  // only the owner sees the pending flag, only the owner approves
  assert.equal((await rpc("santa_my_event", { p_token: t[0] })).participants[2].pending, true);
  assert.equal((await rpc("santa_my_event", { p_token: t[1] })).participants[2].pending, false);
  await assert.rejects(() => rpc("santa_approve_new_link", { p_token: t[1], p_participant_id: ps[2].id, p_approve: true }), /Only a host/);
  await rpc("santa_approve_new_link", { p_token: t[0], p_participant_id: ps[2].id, p_approve: true });

  await assert.rejects(() => rpc("santa_my_event", { p_token: t[2] }), /not valid/, "old link stops working");
  let me = await rpc("santa_my_event", { p_token: newTok });
  assert.equal(me.me.recovering, true);
  assert.equal(me.assignment, null);
  assert.equal(me.recovery.needed, 4);
  assert.deepEqual(me.recovery.votes, []);
  assert.deepEqual(me.participants[2].public_key, newKey);

  await assert.rejects(() => rpc("santa_restore_match", { p_token: newTok, p_sealed: "m".repeat(40) }), /Still waiting/);
  await assert.rejects(() => rpc("santa_cast_vote", { p_token: newTok, p_for_id: ps[2].id, p_sealed: "v".repeat(40) }), /Not ready/);
  await assert.rejects(() => rpc("santa_cast_vote", { p_token: t[1], p_for_id: ps[3].id, p_sealed: "v".repeat(40) }), /Nobody needs/);
  for (const i of [0, 1, 3, 4]) {
    await rpc("santa_cast_vote", { p_token: t[i], p_for_id: ps[2].id, p_sealed: `vote${i}`.padEnd(40, "v") });
  }
  await rpc("santa_cast_vote", { p_token: t[1], p_for_id: ps[2].id, p_sealed: "again".padEnd(40, "v") }); // re-vote is fine
  assert.deepEqual((await rpc("santa_my_event", { p_token: t[1] })).votes_cast, [ps[2].id]);
  me = await rpc("santa_my_event", { p_token: newTok });
  assert.equal(me.recovery.votes.length, 4);

  await rpc("santa_restore_match", { p_token: newTok, p_sealed: "m".repeat(40) });
  me = await rpc("santa_my_event", { p_token: newTok });
  assert.equal(me.me.recovering, false);
  assert.equal(me.assignment, "m".repeat(40));
  assert.equal(me.recovery, null);
});

test("lost link before the draw just swaps the key; decline clears the request", async () => {
  const { rpc } = await fresh();
  const { code, t } = await group(rpc, 3);
  const ps = (await rpc("santa_my_event", { p_token: t[0] })).participants;
  const a = tok();
  await rpc("santa_request_new_link", { p_code: code, p_name: "P1", p_public_key: key(), p_token: a });
  await rpc("santa_approve_new_link", { p_token: t[0], p_participant_id: ps[1].id, p_approve: false });
  assert.equal((await rpc("santa_link_status", { p_token: a })).status, "unknown");
  assert.equal((await rpc("santa_my_event", { p_token: t[1] })).me.name, "P1", "old link still works after decline");
  const b = tok();
  await rpc("santa_request_new_link", { p_code: code, p_name: "P1", p_public_key: key(), p_token: b });
  await rpc("santa_approve_new_link", { p_token: t[0], p_participant_id: ps[1].id, p_approve: true });
  const me = await rpc("santa_my_event", { p_token: b });
  assert.equal(me.me.recovering, false);
});

test("co-hosts: only the starter picks them; they approve links and receive sealed backups", async () => {
  const { rpc } = await fresh();
  const { code, t } = await group(rpc, 5);
  const ps = (await rpc("santa_my_event", { p_token: t[0] })).participants;
  await assert.rejects(() => rpc("santa_set_host", { p_token: t[2], p_participant_id: ps[1].id, p_is_host: true }), /Only the person/);
  await rpc("santa_set_host", { p_token: t[0], p_participant_id: ps[1].id, p_is_host: true });
  const coco = await rpc("santa_my_event", { p_token: t[1] });
  assert.equal(coco.me.is_host, true);
  assert.deepEqual(coco.link_backups, []);
  assert.equal((await rpc("santa_my_event", { p_token: t[2] })).link_backups, null, "non-hosts get nothing");
  assert.deepEqual(coco.participants.filter((p) => p.is_host).map((p) => p.name), ["P0", "P1"]);

  // backups only go to hosts, and only hosts see the ones meant for them
  await assert.rejects(() => rpc("santa_give_backup", { p_token: t[3], p_host_id: ps[2].id, p_sealed: "b".repeat(40) }), /isn't a co-host/);
  for (const i of [0, 2, 3, 4]) await rpc("santa_give_backup", { p_token: t[i], p_host_id: ps[1].id, p_sealed: `for-coco-${i}`.padEnd(40, "b") });
  await assert.rejects(() => rpc("santa_give_backup", { p_token: t[2], p_host_id: ps[0].id, p_sealed: "for-apple".padEnd(40, "b") }), /isn't a co-host/, "the starter doesn't collect links");
  const cocoB = (await rpc("santa_my_event", { p_token: t[1] })).link_backups;
  assert.equal(cocoB.length, 4);
  assert.ok(cocoB.every((b) => b.sealed.startsWith("for-coco")));
  assert.equal((await rpc("santa_my_event", { p_token: t[0] })).link_backups, null);
  assert.deepEqual((await rpc("santa_my_event", { p_token: t[2] })).backups_given, [ps[1].id]);

  // a co-host sees and approves new-link requests; stale backups are cleared
  const nt = tok();
  await rpc("santa_request_new_link", { p_code: code, p_name: "P2", p_public_key: key(), p_token: nt });
  assert.equal((await rpc("santa_my_event", { p_token: t[1] })).participants[2].pending, true);
  await rpc("santa_approve_new_link", { p_token: t[1], p_participant_id: ps[2].id, p_approve: true });
  assert.equal((await rpc("santa_my_event", { p_token: t[1] })).link_backups.length, 3, "P2's old link backup is gone");
  assert.deepEqual((await rpc("santa_my_event", { p_token: nt })).backups_given, []);

  // with a co-host, even the starter can recover a lost link
  const ot = tok();
  await rpc("santa_request_new_link", { p_code: code, p_name: "P0", p_public_key: key(), p_token: ot });
  await assert.rejects(() => rpc("santa_approve_new_link", { p_token: t[0], p_participant_id: ps[0].id, p_approve: true }), /Someone else/);
  await rpc("santa_approve_new_link", { p_token: t[1], p_participant_id: ps[0].id, p_approve: true });
  assert.equal((await rpc("santa_my_event", { p_token: ot })).me.is_owner, true);

  // removing a co-host throws away their backups
  await rpc("santa_set_host", { p_token: ot, p_participant_id: ps[1].id, p_is_host: false });
  assert.equal((await rpc("santa_my_event", { p_token: t[1] })).link_backups, null);
});
