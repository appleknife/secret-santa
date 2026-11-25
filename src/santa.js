/**
 * The app's flows, independent of any page markup:
 * start a group, join, load "my page", draw names, send and open gifts.
 *
 * Secrets: a person's private link carries their token (to sign in) and their
 * private key (to open things sealed for them). Neither is ever uploaded.
 */

import { makeAssignments } from "./assign.js";
import { newKeyPair, newToken, seal, open, privateFragment } from "./keys.js";

export const CAP_USD = 20;

async function identity() {
  const { publicKey, privateKey } = await newKeyPair();
  const token = newToken();
  return { publicKey, privateKey, token, fragment: privateFragment(token, privateKey) };
}

export async function createGroup(db, { title, giftDay, name, wishlist, giftPref }) {
  const id = await identity();
  const res = await db.createEvent({ title, giftDay, name, wishlist, giftPref, publicKey: id.publicKey, token: id.token });
  return { code: res.code, fragment: id.fragment };
}

export async function joinGroup(db, code, { name, wishlist, giftPref }) {
  const id = await identity();
  const res = await db.joinEvent({ code, name, wishlist, giftPref, publicKey: id.publicKey, token: id.token });
  return { code: res.code, fragment: id.fragment };
}

/**
 * Everything for one person's page, with their match and gifts already opened.
 * @param {{token:string, privateKey:object}} secret  from parsePrivateFragment
 */
export async function loadMe(db, secret, opts = {}) {
  const state = await db.myEvent(secret.token);
  const byId = new Map(state.participants.map((p) => [p.id, p]));

  let match = null;
  if (state.assignment) {
    try {
      const data = JSON.parse(await open(state.assignment, secret.privateKey));
      match = byId.get(data.receiver_id) || { id: data.receiver_id, name: data.receiver_name, wishlist: "", left: true };
    } catch {
      match = { error: "Your match couldn't be unlocked with this link. Are you using your newest private link?" };
    }
  }

  // Help anyone who lost their link: tell them (sealed to their new key, so only
  // they can read it) who *we* are buying for. Once everyone else has, their
  // browser can work out the one person nobody else has.
  if (match && !match.error && !state.me.recovering) {
    for (const p of state.participants) {
      if (!p.recovering || p.id === state.me.id || state.votes_cast.includes(p.id)) continue;
      try {
        await db.castVote(secret.token, p.id, await seal(JSON.stringify({ receiver_id: match.id }), p.public_key));
      } catch {
        /* not critical; we'll try again next visit */
      }
    }
  }

  // Leave each co-host a copy of our private link, sealed so only they can open it.
  const myLink = privateFragment(secret.token, secret.privateKey);
  for (const h of state.participants) {
    if (!h.is_cohost || h.id === state.me.id || (state.backups_given || []).includes(h.id)) continue;
    try {
      await db.giveBackup(secret.token, h.id, await seal(JSON.stringify({ link: myLink }), h.public_key));
    } catch {
      /* not critical; we'll try again next visit */
    }
  }

  // Co-hosts: open the backups people left for us. (Only links, never matches.)
  let memberLinks = null;
  if (state.me.is_cohost && Array.isArray(state.link_backups)) {
    memberLinks = [];
    for (const b of state.link_backups) {
      try {
        const link = JSON.parse(await open(b.sealed, secret.privateKey)).link;
        if (/^#\/me\/[A-Za-z0-9_.-]+$/.test(link)) memberLinks.push({ member: byId.get(b.member_id), link });
      } catch { /* skip */ }
    }
    memberLinks = memberLinks.filter((x) => x.member);
  }

  let recovery = null;
  if (state.me.recovering && state.recovery) {
    const { needed, votes } = state.recovery;
    recovery = { have: votes.length, needed };
    if (votes.length >= needed && !opts.restored) {
      const taken = new Set();
      for (const v of votes) {
        try { taken.add(JSON.parse(await open(v, secret.privateKey)).receiver_id); } catch { /* skip bad vote */ }
      }
      const recovering = state.participants.filter((p) => p.recovering).map((p) => p.id);
      const untaken = state.participants.filter((p) => !taken.has(p.id)).map((p) => p.id);
      const split = taken.size === votes.length ? splitRecovered(recovering, untaken) : null;
      const target = split && byId.get(split.get(state.me.id));
      if (target) {
        const mine = byId.get(state.me.id).public_key;
        const payload = JSON.stringify({ receiver_id: target.id, receiver_name: target.name });
        await db.restoreMatch(secret.token, await seal(payload, mine));
        return loadMe(db, secret, { restored: true });
      }
      recovery.problem = true;
    }
  }

  const received = [];
  for (const g of state.gifts_received) {
    let gift = null;
    if (g.sealed) {
      try { gift = JSON.parse(await open(g.sealed, secret.privateKey)); }
      catch {
        gift = { kind: "note", locked: true,
                 message: "This gift was sent to an old private link, so it can't be opened. Your Secret Santa can send it again." };
      }
    }
    received.push({ ...g, gift });
  }

  const sent = state.gifts_sent.map((g) => ({ ...g, recipient: byId.get(g.recipient_id) }));
  return { ...state, match, received, sent, recovery, memberLinks };
}

/**
 * Who should each recovering person buy for?
 *
 * `untaken` is everyone nobody else is buying for: exactly the targets of the
 * people who lost their links. With one lost link that's a single person. With
 * several, any pairing where nobody gets themselves is as good as the original
 * (none of them knew their target), so every recovering browser picks the
 * *same* one: the first valid pairing in id order. Often only one is valid,
 * and then it is exactly the original.
 *
 * Returns Map(recoveringId -> targetId), or null if it can't be done.
 */
export function splitRecovered(recoveringIds, untakenIds) {
  const R = [...recoveringIds].sort();
  const U = [...untakenIds].sort();
  if (R.length === 0 || R.length !== U.length) return null;
  const used = new Array(U.length).fill(false);
  const pick = [];
  const search = (i) => {
    if (i === R.length) return true;
    for (let j = 0; j < U.length; j++) {
      if (used[j] || U[j] === R[i]) continue;
      used[j] = true;
      pick.push(U[j]);
      if (search(i + 1)) return true;
      used[j] = false;
      pick.pop();
    }
    return false;
  };
  if (!search(0)) return null;
  return new Map(R.map((r, i) => [r, pick[i]]));
}

/** Lost your link? Make a new one here; the group starter approves it. */
export async function requestNewLink(db, code, name) {
  const id = await identity();
  const res = await db.requestNewLink({ code, name, publicKey: id.publicKey, token: id.token });
  return { fragment: id.fragment, ownerName: res.owner_name };
}

/**
 * Pair everyone and store each person's match sealed to their own key.
 * The pairing exists only in this function's memory; nothing displays it and
 * the database only ever receives the sealed envelopes.
 */
export async function drawNames(db, secret, rng = Math.random) {
  const state = await db.myEvent(secret.token);
  if (!state.me.is_owner) throw new Error("Only the person who started the group can draw names.");
  const people = state.participants;
  if (people.length < 3) throw new Error("You need at least 3 people to draw names.");
  const byId = new Map(people.map((p) => [p.id, p]));
  const pairs = makeAssignments(people.map((p) => p.id), [], rng);
  const rows = [];
  for (const [giverId, receiverId] of pairs) {
    const receiver = byId.get(receiverId);
    const payload = JSON.stringify({ receiver_id: receiverId, receiver_name: receiver.name });
    rows.push({ giver_id: giverId, sealed: await seal(payload, byId.get(giverId).public_key) });
  }
  pairs.clear();
  await db.submitDraw(secret.token, rows);
}

/** Clean up what a giver typed into a gift. Returns a plain object. */
export function normalizeGift(input) {
  const kind = ["giftcard", "art", "note"].includes(input.kind) ? input.kind : "note";
  const trim = (v, n) => String(v || "").trim().slice(0, n);
  const gift = { kind, message: trim(input.message, 1500) };
  if (kind === "giftcard") {
    gift.store = trim(input.store, 60);
    gift.amount = trim(input.amount, 12).replace(/^\$/, "");
    gift.code = trim(input.code, 300);
    gift.link = trim(input.link, 500);
    if (!gift.code && !gift.link) throw new Error("Add the gift card code or redeem link.");
  }
  if (kind === "art") {
    gift.link = trim(input.link, 500);
    gift.image = typeof input.image === "string" && input.image.startsWith("data:image/") ? input.image : "";
    if (!gift.image && !gift.link) throw new Error("Attach your drawing or paste a link to it.");
  }
  if (kind === "note" && !gift.message) throw new Error("Write a little note first.");
  if (gift.link && !/^https?:\/\//i.test(gift.link)) gift.link = "https://" + gift.link;
  return gift;
}

/** True when a typed amount is over the group's cap. */
export function overCap(amount, cap = CAP_USD) {
  const n = parseFloat(String(amount || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > cap;
}

export async function sendGift(db, secret, recipient, input) {
  const gift = normalizeGift(input);
  const sealed = await seal(JSON.stringify(gift), recipient.public_key);
  return db.sendGift(secret.token, recipient.id, sealed);
}
