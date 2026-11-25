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
    // ciphertext is base64url, so plaintext JSON (quotes, braces, field names) can't hide in it;
    // short names like "Kai" can appear by pure chance in random base64, so don't test for those
    assert.match(a.sealed, /^s1(\.[A-Za-z0-9_-]+){3}$/);
    assert.ok(!/receiver_|[{}":]/.test(a.sealed));
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

test("lost link after the draw: new link, approval, everyone else helps, same match comes back", async () => {
  const { db, secrets, code, names } = await fivePals();
  await drawNames(db, secrets[0]);
  const before = {};
  for (let i = 0; i < 5; i++) before[names[i]] = (await loadMe(db, secrets[i])).match.name;

  // Kai (index 2) lost his link
  const { requestNewLink } = await import("../src/santa.js");
  const req = await requestNewLink(db, code, "kai");
  assert.equal(req.ownerName, "Don");
  const kai = parsePrivateFragment(req.fragment);
  assert.equal((await db.linkStatus(kai.token)).status, "pending");
  const ownerView = await loadMe(db, secrets[0]);
  assert.equal(ownerView.participants.find((p) => p.name === "Kai").pending, true);
  await db.approveNewLink(secrets[0].token, ownerView.participants.find((p) => p.name === "Kai").id, true);

  // Owner already voted during the loadMe above? No: Kai wasn't recovering yet.
  let k = await loadMe(db, kai);
  assert.equal(k.match, null);
  assert.deepEqual(k.recovery, { have: 0, needed: 4 });

  // the others open the app one by one; nobody but Kai's browser can read the votes
  for (const i of [0, 1, 3]) await loadMe(db, secrets[i]);
  k = await loadMe(db, kai);
  assert.deepEqual(k.recovery, { have: 3, needed: 4 });
  await loadMe(db, secrets[4]);                // the friend who was asleep
  k = await loadMe(db, kai);
  assert.equal(k.recovery, null);
  assert.equal(k.match.name, before.Kai, "same target as before");
  await assert.rejects(() => loadMe(db, secrets[2]), /not valid/, "old link is dead");

  // nothing else changed for anyone
  for (const i of [0, 1, 3, 4]) assert.equal((await loadMe(db, secrets[i])).match.name, before[names[i]]);
});

test("gifts sent to an old link explain themselves", async () => {
  let clock = new Date("2026-12-21T12:00:00Z");
  const { db, secrets, code, names } = await fivePals(() => clock);
  await drawNames(db, secrets[0]);
  const santaOfKai = await (async () => {
    for (let i = 0; i < 5; i++) if ((await loadMe(db, secrets[i])).match.name === "Kai") return i;
  })();
  const giver = await loadMe(db, secrets[santaOfKai]);
  await sendGift(db, secrets[santaOfKai], giver.match, { kind: "note", message: "hi Kai" });
  const { requestNewLink } = await import("../src/santa.js");
  const req = await requestNewLink(db, code, "Kai");
  const kaiId = (await loadMe(db, secrets[0])).participants.find((p) => p.name === "Kai").id;
  await db.approveNewLink(secrets[0].token, kaiId, true);
  const k = await loadMe(db, parsePrivateFragment(req.fragment));
  assert.equal(k.received[0].gift.locked, true);
  assert.match(k.received[0].gift.message, /old private link/);
});

test("splitRecovered: forced, free and impossible cases", async () => {
  const { splitRecovered } = await import("../src/santa.js");
  // one lost link: the single untaken person
  assert.deepEqual([...splitRecovered(["x"], ["t"])], [["x", "t"]]);
  // two lost links that had each other: forced swap
  assert.deepEqual(Object.fromEntries(splitRecovered(["y", "x"], ["x", "y"])), { x: "y", y: "x" });
  // one of them is untaken: forced
  assert.deepEqual(Object.fromEntries(splitRecovered(["x", "y"], ["y", "t"])), { x: "y", y: "t" });
  // free choice: always the same answer whatever order things arrive in
  const a = Object.fromEntries(splitRecovered(["x", "y"], ["s", "t"]));
  const b = Object.fromEntries(splitRecovered(["y", "x"], ["t", "s"]));
  assert.deepEqual(a, b);
  assert.equal(splitRecovered(["x"], ["x"]), null);
  assert.equal(splitRecovered(["x", "y"], ["s"]), null);
});

test("two friends lose their links at once (40 random draws): everyone ends up with a valid match", async () => {
  const { requestNewLink } = await import("../src/santa.js");
  let forced = 0, free = 0;
  for (let run = 0; run < 40; run++) {
    const { db, secrets, code, names } = await fivePals();
    await drawNames(db, secrets[0]);
    const before = {};
    for (let i = 0; i < 5; i++) before[names[i]] = (await loadMe(db, secrets[i])).match.name;

    // Kai and Rin (2, 3) both lose their links; Don approves both
    const lost = [2, 3];
    const fresh = {};
    for (const i of lost) fresh[i] = parsePrivateFragment((await requestNewLink(db, code, names[i])).fragment);
    const ps = (await loadMe(db, secrets[0])).participants;
    for (const i of lost) await db.approveNewLink(secrets[0].token, ps[i].id, true);

    // everyone opens the app in a random order, a few times over
    const order = [0, 1, 2, 3, 4].sort(() => Math.random() - 0.5);
    for (let round = 0; round < 2; round++) {
      for (const i of order) await loadMe(db, lost.includes(i) ? fresh[i] : secrets[i]);
    }

    const after = {};
    for (let i = 0; i < 5; i++) {
      const m = await loadMe(db, lost.includes(i) ? fresh[i] : secrets[i]);
      assert.ok(m.match && m.match.name, `run ${run}: ${names[i]} has a match`);
      assert.equal(m.recovery, null);
      after[names[i]] = m.match.name;
    }
    // the three who kept their links are untouched
    for (const i of [0, 1, 4]) assert.equal(after[names[i]], before[names[i]]);
    // still a proper Secret Santa: nobody draws themselves, everyone receives once
    for (const n of names) assert.notEqual(after[n], n);
    assert.deepEqual(Object.values(after).sort(), [...names].sort());
    // if only one split was possible, they got exactly their original targets
    const pool = [before.Kai, before.Rin];
    const onlyOne = pool.includes("Kai") || pool.includes("Rin");
    if (onlyOne) {
      forced++;
      assert.equal(after.Kai, before.Kai);
      assert.equal(after.Rin, before.Rin);
    } else {
      free++;
      assert.deepEqual([after.Kai, after.Rin].sort(), pool.sort());
    }
  }
  assert.ok(forced > 0 && free > 0, `covered both cases (forced ${forced}, free ${free})`);
});

test("co-host Coco gets everyone's working private link once they've opened the app", async () => {
  const { db, secrets, names } = await fivePals();
  await drawNames(db, secrets[0]);
  const ps = (await loadMe(db, secrets[0])).participants;
  await assert.rejects(() => db.setHost(secrets[2].token, ps[1].id, true), /Only the person/);
  await db.setHost(secrets[0].token, ps[1].id, true); // Mia (index 1) plays Coco

  let coco = await loadMe(db, secrets[1]);
  assert.equal(coco.me.is_host, true);
  assert.equal(coco.memberLinks.length, 0, "nobody has opened the app since");
  assert.equal((await loadMe(db, secrets[2])).memberLinks, null, "non-hosts never get links");

  for (const i of [0, 2, 3, 4]) await loadMe(db, secrets[i]);
  coco = await loadMe(db, secrets[1]);
  assert.deepEqual(coco.memberLinks.map((x) => x.member.name).sort(), ["Don", "Kai", "Rin", "Sol"]);
  for (const { member, link } of coco.memberLinks) {
    const opened = await loadMe(db, parsePrivateFragment(link));
    assert.equal(opened.me.name, member.name, "the copied link really opens that person's page");
    assert.ok(!JSON.stringify(member).includes("receiver"), "the list itself carries no match info");
  }
  // the starter can approve links but does NOT receive anyone's link
  assert.equal((await loadMe(db, secrets[0])).memberLinks, null);
});
