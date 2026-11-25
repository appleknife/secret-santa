/**
 * Data layer. Two interchangeable backends with the same methods:
 *
 *   supabaseBackend(url, key)  — calls the functions in supabase/schema.sql
 *   demoBackend(storage)       — the same rules in plain JS, saved in one
 *                                browser (localStorage), for trying things out
 *
 * Every method mirrors one database function. Errors meant for people are
 * thrown as Error with a friendly message.
 */

const GIFT_EARLY_HOURS = 12;
const MAX_GIFTS_PER_SENDER = 10;

export function supabaseBackend(url, key) {
  const base = url.replace(/\/+$/, "");
  async function rpc(fn, args) {
    let res;
    try {
      res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: key, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
    } catch {
      throw new Error("Couldn't reach the Secret Santa server. Check your connection and try again.");
    }
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = body && body.code === "P0001" && body.message;
      throw new Error(msg || "Something went wrong on the server. Please try again.");
    }
    return body;
  }
  return {
    mode: "supabase",
    createEvent: (a) => rpc("santa_create_event", {
      p_title: a.title, p_gift_day: a.giftDay || null, p_name: a.name, p_wishlist: a.wishlist,
      p_gift_pref: a.giftPref, p_public_key: a.publicKey, p_token: a.token,
    }),
    eventPreview: (code) => rpc("santa_event_preview", { p_code: code }),
    joinEvent: (a) => rpc("santa_join_event", {
      p_code: a.code, p_name: a.name, p_wishlist: a.wishlist, p_gift_pref: a.giftPref,
      p_public_key: a.publicKey, p_token: a.token,
    }),
    myEvent: (token) => rpc("santa_my_event", { p_token: token }),
    updateMe: (token, wishlist, giftPref) =>
      rpc("santa_update_me", { p_token: token, p_wishlist: wishlist, p_gift_pref: giftPref }),
    removeParticipant: (token, id) => rpc("santa_remove_participant", { p_token: token, p_participant_id: id }),
    submitDraw: (token, rows) => rpc("santa_submit_draw", { p_token: token, p_rows: rows }),
    sendGift: (token, recipientId, sealed) =>
      rpc("santa_send_gift", { p_token: token, p_recipient_id: recipientId, p_sealed: sealed }),
    unsendGift: (token, giftId) => rpc("santa_unsend_gift", { p_token: token, p_gift_id: giftId }),
    openGift: (token, giftId) => rpc("santa_open_gift", { p_token: token, p_gift_id: giftId }),
    deleteEvent: (token) => rpc("santa_delete_event", { p_token: token }),
    requestNewLink: (a) => rpc("santa_request_new_link", {
      p_code: a.code, p_name: a.name, p_public_key: a.publicKey, p_token: a.token,
    }),
    linkStatus: (token) => rpc("santa_link_status", { p_token: token }),
    approveNewLink: (token, id, approve) =>
      rpc("santa_approve_new_link", { p_token: token, p_participant_id: id, p_approve: approve }),
    castVote: (token, forId, sealed) => rpc("santa_cast_vote", { p_token: token, p_for_id: forId, p_sealed: sealed }),
    restoreMatch: (token, sealed) => rpc("santa_restore_match", { p_token: token, p_sealed: sealed }),
    setHost: (token, id, isHost) => rpc("santa_set_host", { p_token: token, p_participant_id: id, p_is_host: isHost }),
    giveBackup: (token, hostId, sealed) => rpc("santa_give_backup", { p_token: token, p_host_id: hostId, p_sealed: sealed }),
  };
}

/* ───────────────────────────── demo backend ───────────────────────────── */

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const uid = () => crypto.randomUUID();
const fail = (msg) => { throw new Error(msg); };
const cleanPref = (p) => (["handmade", "digital", "either"].includes(p) ? p : "either");

function checkKey(k) {
  if (!k || k.kty !== "EC" || k.crv !== "P-256" || "d" in k || String(k.x).length !== 43 || String(k.y).length !== 43) {
    fail("Bad public key.");
  }
}
function checkName(name) {
  const n = String(name || "").trim();
  if (n.length < 1 || n.length > 40) fail("Names need to be 1–40 characters.");
  return n;
}

/**
 * @param {{getItem(k:string):string|null, setItem(k:string,v:string):void}} storage
 * @param {() => Date} now  injectable clock for tests
 */
export function demoBackend(storage, now = () => new Date()) {
  const KEY = "secret-santa-demo-v1";
  const load = () => {
    const empty = { events: [], participants: [], assignments: [], gifts: [], votes: [], backups: [] };
    try { return { ...empty, ...(JSON.parse(storage.getItem(KEY)) || {}) }; }
    catch { return empty; }
  };
  const save = (db) => storage.setItem(KEY, JSON.stringify(db));

  async function me(db, token) {
    if (!token || String(token).length < 20) fail("That private link is not valid.");
    const h = await sha256(token);
    return db.participants.find((p) => p.token_hash === h) || fail("That private link is not valid.");
  }
  const eventOf = (db, p) => db.events.find((e) => e.id === p.event_id);
  const isHost = (db, p) => Boolean(p.is_host) || eventOf(db, p).owner_id === p.id;
  const giftsOpen = (ev) => !ev.gift_day ||
    now().getTime() >= Date.parse(`${ev.gift_day}T00:00:00Z`) - GIFT_EARLY_HOURS * 3600e3;

  async function addParticipant(db, ev, a) {
    checkKey(a.publicKey);
    if (String(a.token || "").length < 20) fail("Bad token.");
    const name = checkName(a.name);
    if (db.participants.some((p) => p.event_id === ev.id && p.name.toLowerCase() === name.toLowerCase())) {
      fail("Someone in this group already uses that name. Try adding an initial.");
    }
    const p = {
      id: uid(), event_id: ev.id, name, wishlist: String(a.wishlist || "").slice(0, 1000),
      gift_pref: cleanPref(a.giftPref), public_key: a.publicKey,
      token_hash: await sha256(a.token), created_at: now().toISOString(),
    };
    db.participants.push(p);
    return p;
  }

  return {
    mode: "demo",
    async createEvent(a) {
      const db = load();
      const title = String(a.title || "").trim();
      if (!title || title.length > 60) fail("Give your group a name (up to 60 characters).");
      const ev = { id: uid(), code: uid().replace(/-/g, "").slice(0, 10), title, gift_day: a.giftDay || null,
                   cap_usd: 20, status: "open", owner_id: null, drawn_at: null };
      db.events.push(ev);
      const p = await addParticipant(db, ev, a);
      ev.owner_id = p.id;
      save(db);
      return { code: ev.code, participant_id: p.id };
    },
    async eventPreview(code) {
      const db = load();
      const ev = db.events.find((e) => e.code === code) || fail("We could not find that group. Check the link?");
      return { title: ev.title, gift_day: ev.gift_day, cap_usd: ev.cap_usd, status: ev.status,
               names: db.participants.filter((p) => p.event_id === ev.id).map((p) => p.name) };
    },
    async joinEvent(a) {
      const db = load();
      const ev = db.events.find((e) => e.code === a.code) || fail("We could not find that group. Check the link?");
      if (ev.status !== "open") fail("Names have already been drawn for this group, so it is closed to new people.");
      if (db.participants.filter((p) => p.event_id === ev.id).length >= 40) fail("This group is full.");
      const p = await addParticipant(db, ev, a);
      save(db);
      return { code: ev.code, participant_id: p.id };
    },
    async myEvent(token) {
      const db = load();
      const m = await me(db, token);
      const ev = eventOf(db, m);
      const open = giftsOpen(ev);
      const tag = await sha256("gift:" + token);
      const a = db.assignments.find((x) => x.event_id === ev.id && x.giver_id === m.id);
      return {
        event: { code: ev.code, title: ev.title, gift_day: ev.gift_day, cap_usd: ev.cap_usd,
                 status: ev.status, drawn_at: ev.drawn_at, gifts_open: open },
        me: { id: m.id, name: m.name, wishlist: m.wishlist, gift_pref: m.gift_pref, is_owner: ev.owner_id === m.id,
              is_host: isHost(db, m), is_cohost: Boolean(m.is_host), recovering: Boolean(m.recovering) },
        participants: db.participants.filter((p) => p.event_id === ev.id).map((p) => ({
          id: p.id, name: p.name, wishlist: p.wishlist, gift_pref: p.gift_pref,
          public_key: p.public_key, is_owner: ev.owner_id === p.id,
          recovering: Boolean(p.recovering),
          is_host: isHost(db, p),
          is_cohost: Boolean(p.is_host),
          pending: isHost(db, m) ? Boolean(p.pending_token_hash) : false })),
        votes_cast: db.votes.filter((x) => x.voter_id === m.id).map((x) => x.for_id),
        backups_given: db.backups.filter((x) => x.member_id === m.id).map((x) => x.host_id),
        link_backups: m.is_host
          ? db.backups.filter((x) => x.host_id === m.id).map((x) => ({ member_id: x.member_id, sealed: x.sealed }))
          : null,
        recovery: m.recovering ? {
          needed: db.participants.filter((p) => p.event_id === ev.id && p.id !== m.id && !p.recovering).length,
          votes: db.votes.filter((x) => x.for_id === m.id).map((x) => x.sealed),
        } : null,
        assignment: a ? a.sealed : null,
        gifts_received: db.gifts.filter((g) => g.recipient_id === m.id).map((g) => ({
          id: g.id, sent_at: g.created_at, opened_at: g.opened_at, sealed: open ? g.sealed : null })),
        gifts_sent: db.gifts.filter((g) => g.sender_tag === tag && g.event_id === ev.id).map((g) => ({
          id: g.id, recipient_id: g.recipient_id, sent_at: g.created_at, opened_at: g.opened_at })),
      };
    },
    async updateMe(token, wishlist, giftPref) {
      const db = load();
      const m = await me(db, token);
      m.wishlist = String(wishlist || "").slice(0, 1000);
      m.gift_pref = cleanPref(giftPref);
      save(db);
    },
    async removeParticipant(token, id) {
      const db = load();
      const m = await me(db, token);
      const ev = eventOf(db, m);
      if (ev.owner_id !== m.id) fail("Only the person who started the group can remove people.");
      if (ev.status !== "open") fail("Names have already been drawn.");
      if (id === m.id) fail("You can't remove yourself.");
      db.participants = db.participants.filter((p) => !(p.id === id && p.event_id === ev.id));
      save(db);
    },
    async submitDraw(token, rows) {
      const db = load();
      const m = await me(db, token);
      const ev = eventOf(db, m);
      if (ev.owner_id !== m.id) fail("Only the person who started the group can draw names.");
      if (ev.status !== "open") fail("Names have already been drawn.");
      const ids = db.participants.filter((p) => p.event_id === ev.id).map((p) => p.id);
      if (ids.length < 3) fail("You need at least 3 people to draw names.");
      const givers = new Set((rows || []).map((r) => r.giver_id));
      const ok = Array.isArray(rows) && rows.length === ids.length && givers.size === ids.length &&
        rows.every((r) => ids.includes(r.giver_id) && String(r.sealed || "").length >= 20);
      if (!ok) fail("Someone joined or left while drawing. Please try again.");
      for (const r of rows) db.assignments.push({ event_id: ev.id, giver_id: r.giver_id, sealed: r.sealed });
      ev.status = "drawn";
      ev.drawn_at = now().toISOString();
      save(db);
    },
    async sendGift(token, recipientId, sealed) {
      const db = load();
      const m = await me(db, token);
      const ev = eventOf(db, m);
      if (ev.status !== "drawn") fail("Names haven't been drawn yet.");
      if (recipientId === m.id || !db.participants.some((p) => p.id === recipientId && p.event_id === ev.id)) {
        fail("That person isn't in your group.");
      }
      const len = String(sealed || "").length;
      if (len < 20 || len > 700000) fail("That gift is too large. Try a smaller picture.");
      const tag = await sha256("gift:" + token);
      if (db.gifts.filter((g) => g.sender_tag === tag).length >= MAX_GIFTS_PER_SENDER) fail("That's plenty of gifts! (Limit 10.)");
      const g = { id: uid(), event_id: ev.id, recipient_id: recipientId, sender_tag: tag, sealed,
                  created_at: now().toISOString(), opened_at: null };
      db.gifts.push(g);
      try { save(db); } catch { fail("This browser ran out of demo storage. Try a smaller picture."); }
      return g.id;
    },
    async unsendGift(token, giftId) {
      const db = load();
      await me(db, token);
      const tag = await sha256("gift:" + token);
      const i = db.gifts.findIndex((g) => g.id === giftId && g.sender_tag === tag && !g.opened_at);
      if (i < 0) fail("That gift has already been opened, so it can't be taken back.");
      db.gifts.splice(i, 1);
      save(db);
    },
    async openGift(token, giftId) {
      const db = load();
      const m = await me(db, token);
      const g = db.gifts.find((x) => x.id === giftId && x.recipient_id === m.id);
      if (g && !g.opened_at) { g.opened_at = now().toISOString(); save(db); }
    },
    async deleteEvent(token) {
      const db = load();
      const m = await me(db, token);
      const ev = eventOf(db, m);
      if (ev.owner_id !== m.id) fail("Only the person who started the group can delete it.");
      const gone = new Set(db.participants.filter((p) => p.event_id === ev.id).map((p) => p.id));
      db.events = db.events.filter((e) => e.id !== ev.id);
      db.participants = db.participants.filter((p) => !gone.has(p.id));
      db.assignments = db.assignments.filter((a) => a.event_id !== ev.id);
      db.gifts = db.gifts.filter((g) => g.event_id !== ev.id);
      db.votes = db.votes.filter((x) => !gone.has(x.for_id));
      save(db);
    },
    async requestNewLink(a) {
      checkKey(a.publicKey);
      if (String(a.token || "").length < 20) fail("Bad token.");
      const db = load();
      const ev = db.events.find((e) => e.code === a.code) || fail("We could not find that group. Check the link?");
      const name = String(a.name || "").trim().toLowerCase();
      const p = db.participants.find((x) => x.event_id === ev.id && x.name.toLowerCase() === name) ||
        fail("Nobody in this group has that name.");
      if (!db.participants.some((h) => h.event_id === ev.id && h.id !== p.id && isHost(db, h))) {
        fail("Nobody else in the group can approve a new link for you. Make someone a co-host first.");
      }
      p.pending_key = a.publicKey;
      p.pending_token_hash = await sha256(a.token);
      save(db);
      return { owner_name: db.participants.find((x) => x.id === ev.owner_id).name };
    },
    async linkStatus(token) {
      const db = load();
      const h = await sha256(String(token || ""));
      if (db.participants.some((p) => p.token_hash === h)) return { status: "active" };
      const p = db.participants.find((x) => x.pending_token_hash === h);
      if (!p) return { status: "unknown" };
      const ev = db.events.find((e) => e.id === p.event_id);
      return { status: "pending", title: ev.title, name: p.name,
               owner_name: db.participants.find((x) => x.id === ev.owner_id).name };
    },
    async approveNewLink(token, id, approve) {
      const db = load();
      const m = await me(db, token);
      const ev = eventOf(db, m);
      if (!isHost(db, m)) fail("Only a host can approve new links.");
      if (id === m.id) fail("Someone else has to approve your own new link.");
      const p = db.participants.find((x) => x.id === id && x.event_id === ev.id);
      if (!p || !p.pending_token_hash) fail("That request isn't there anymore.");
      if (approve) {
        p.token_hash = p.pending_token_hash;
        p.public_key = p.pending_key;
        p.recovering = ev.status === "drawn";
        db.assignments = db.assignments.filter((x) => x.giver_id !== p.id);
        db.votes = db.votes.filter((x) => x.for_id !== p.id);
        db.backups = db.backups.filter((x) => x.member_id !== p.id && x.host_id !== p.id);
      }
      p.pending_key = null;
      p.pending_token_hash = null;
      save(db);
    },
    async castVote(token, forId, sealed) {
      const db = load();
      const m = await me(db, token);
      const ev = eventOf(db, m);
      if (ev.status !== "drawn" || m.recovering) fail("Not ready to help yet.");
      if (forId === m.id || !db.participants.some((p) => p.id === forId && p.event_id === ev.id && p.recovering)) {
        fail("Nobody needs that.");
      }
      db.votes = db.votes.filter((x) => !(x.for_id === forId && x.voter_id === m.id));
      db.votes.push({ for_id: forId, voter_id: m.id, sealed });
      save(db);
    },
    async setHost(token, id, value) {
      const db = load();
      const m = await me(db, token);
      const ev = eventOf(db, m);
      if (ev.owner_id !== m.id) fail("Only the person who started the group can choose co-hosts.");
      const p = db.participants.find((x) => x.id === id && x.event_id === ev.id);
      if (p) p.is_host = Boolean(value);
      if (!value) db.backups = db.backups.filter((x) => x.host_id !== id);
      save(db);
    },
    async giveBackup(token, hostId, sealed) {
      const db = load();
      const m = await me(db, token);
      const h = db.participants.find((x) => x.id === hostId && x.event_id === m.event_id);
      if (!h || !h.is_host || h.id === m.id) fail("That person isn't a co-host.");
      if (String(sealed || "").length < 20) fail("Bad backup.");
      db.backups = db.backups.filter((x) => !(x.host_id === hostId && x.member_id === m.id));
      db.backups.push({ host_id: hostId, member_id: m.id, sealed });
      save(db);
    },
    async restoreMatch(token, sealed) {
      const db = load();
      const m = await me(db, token);
      if (!m.recovering) fail("Your match isn't missing.");
      const need = db.participants.filter((p) => p.event_id === m.event_id && p.id !== m.id && !p.recovering).length;
      if (db.votes.filter((x) => x.for_id === m.id).length < need) fail("Still waiting for everyone to open the app.");
      db.assignments = db.assignments.filter((x) => x.giver_id !== m.id);
      db.assignments.push({ event_id: m.event_id, giver_id: m.id, sealed });
      m.recovering = false;
      db.votes = db.votes.filter((x) => x.for_id !== m.id);
      save(db);
    },
  };
}

/** Pick the backend from config: Supabase when configured, demo otherwise. */
export function makeBackend(config, storage) {
  return config.SUPABASE_URL && config.SUPABASE_KEY
    ? supabaseBackend(config.SUPABASE_URL, config.SUPABASE_KEY)
    : demoBackend(storage);
}
