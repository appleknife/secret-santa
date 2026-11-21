import test from "node:test";
import assert from "node:assert/strict";
import { demoBackend } from "../src/db.js";
import { parsePrivateFragment } from "../src/keys.js";
import { createGroup, joinGroup, loadMe, drawNames, sendGift, normalizeGift, overCap } from "../src/santa.js";

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m };
}

async function fivePals(now) {
  const storage = memoryStorage();
  const db = demoBackend(storage, now);
  const names = ["Don", "Mia", "Kai", "Rin", "Sol"];
  const made = await createGroup(db, { title: "Online pals", giftDay: "2026-12-20", name: "Don", wishlist: "a drawing of my cat", giftPref: "handmade" });
  const secrets = [parsePrivateFragment(made.fragment)];
  for (const name of names.slice(1)) {
    const j = await joinGroup(db, made.code, { name, wishlist: `${name} likes games`, giftPref: "digital" });
    secrets.push(parsePrivateFragment(j.fragment));
  }
  return { db, storage, secrets, names, code: made.code };
}

test("five friends join, draw, and each sees exactly one valid match", async () => {
  const { db, secrets, names } = await fivePals();
  await assert.rejects(() => drawNames(db, secrets[1]), /Only the person/);
  await drawNames(db, secrets[0]);

  const receivers = [];
  for (let i = 0; i < 5; i++) {
    const me = await loadMe(db, secrets[i]);
    assert.equal(me.event.status, "drawn");
    assert.ok(me.match && me.match.name, "has a match");
    assert.notEqual(me.match.name, names[i], "not themselves");
    receivers.push(me.match.name);
  }
  assert.deepEqual([...receivers].sort(), [...names].sort(), "everyone receives exactly once");
});

test("the stored data never contains a readable pairing", async () => {
  const { db, storage, secrets } = await fivePals();
  await drawNames(db, secrets[0]);
  const stored = JSON.parse([...storage.raw.values()][0]);
  for (const a of stored.assignments) {
    assert.ok(a.sealed.startsWith("s1."));
    assert.ok(!/receiver|Don|Mia|Kai|Rin|Sol/.test(a.sealed));
  }
});

test("someone else's link can't open your match", async () => {
  const { db, secrets } = await fivePals();
  await drawNames(db, secrets[0]);
  const mixed = { token: secrets[1].token, privateKey: secrets[2].privateKey };
  const me = await loadMe(db, mixed);
  assert.ok(me.match.error);
});

test("gift card goes only to the recipient, stays wrapped until gift day, then opens", async () => {
  let clock = new Date("2026-12-01T12:00:00Z");
  const { db, secrets } = await fivePals(() => clock);
  await drawNames(db, secrets[0]);
  const giver = await loadMe(db, secrets[0]);
  const recipientIndex = giver.participants.findIndex((p) => p.id === giver.match.id);

  await sendGift(db, secrets[0], giver.match, { kind: "giftcard", store: "Steam", amount: "$20", code: "ABCD-EFGH", message: "Merry Christmas!" });

  let them = await loadMe(db, secrets[recipientIndex]);
  assert.equal(them.received.length, 1);
  assert.equal(them.received[0].gift, null, "wrapped before gift day");

  clock = new Date("2026-12-20T09:00:00Z");
  them = await loadMe(db, secrets[recipientIndex]);
  assert.equal(them.received[0].gift.code, "ABCD-EFGH");
  assert.equal(them.received[0].gift.store, "Steam");

  const sent = await loadMe(db, secrets[0]);
  assert.equal(sent.sent.length, 1);
  assert.equal(sent.sent[0].recipient.id, giver.match.id);
  assert.equal(sent.sent[0].opened_at, null);

  await db.openGift(secrets[recipientIndex].token, them.received[0].id);
  assert.ok((await loadMe(db, secrets[0])).sent[0].opened_at, "giver sees it was opened");

  for (let i = 0; i < 5; i++) {
    if (i === 0) continue;
    const other = await loadMe(db, secrets[i]);
    assert.equal(other.sent.length, 0, "nobody else sees the send");
  }
});

test("joining after the draw is refused; duplicate names are refused", async () => {
  const { db, secrets, code } = await fivePals();
  await assert.rejects(() => joinGroup(db, code, { name: "mia", wishlist: "", giftPref: "either" }), /already uses that name/);
  await drawNames(db, secrets[0]);
  await assert.rejects(() => joinGroup(db, code, { name: "Late", wishlist: "", giftPref: "either" }), /closed/);
});

test("gift input is checked and tidied", () => {
  assert.throws(() => normalizeGift({ kind: "giftcard", store: "Steam" }), /code or redeem link/);
  assert.throws(() => normalizeGift({ kind: "art" }), /drawing/);
  assert.throws(() => normalizeGift({ kind: "note", message: "  " }), /note/);
  const g = normalizeGift({ kind: "art", link: "imgur.com/abc", message: "hi" });
  assert.equal(g.link, "https://imgur.com/abc");
  assert.equal(normalizeGift({ kind: "giftcard", amount: "$15", code: "X" }).amount, "15");
  assert.equal(normalizeGift({ kind: "art", image: "javascript:alert(1)", link: "a.b" }).image, "");
});

test("$20 cap check", () => {
  assert.equal(overCap("25"), true);
  assert.equal(overCap("$20"), false);
  assert.equal(overCap("19.99"), false);
  assert.equal(overCap(""), false);
});

test("only the group starter can delete the group, and it takes everything with it", async () => {
  const { db, secrets, code } = await fivePals();
  await drawNames(db, secrets[0]);
  await assert.rejects(() => db.deleteEvent(secrets[1].token), /Only the person/);
  await db.deleteEvent(secrets[0].token);
  await assert.rejects(() => loadMe(db, secrets[2]), /not valid/);
  await assert.rejects(() => db.eventPreview(code), /could not find/);
});
