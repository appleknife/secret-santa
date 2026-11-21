/**
 * Screens for the sign-up version of Secret Santa.
 *
 *   #/                 home: start a group, or reopen one saved on this device
 *   #/join/<code>      the shared join link
 *   #/me/<secret>      a person's private page (the secret never leaves the browser)
 *
 * All text from people is inserted with textContent, never innerHTML.
 */

import * as config from "./config.js";
import { makeBackend } from "./db.js";
import { parsePrivateFragment } from "./keys.js";
import { createGroup, joinGroup, loadMe, drawNames, sendGift, overCap, CAP_USD } from "./santa.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const storage = safeStorage();
const db = makeBackend(config, storage);
const view = $("#view");
const lede = $("#lede");
let pollTimer = null;

/* ── cute hover sounds, synthesised with Web Audio (no audio files) ── */
let audioCtx = null;
let master = null;
let soundOn = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let lastTone = 0;
let soundToggle = null;

function ensureAudio() {
  if (audioCtx) return true;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  audioCtx = new Ctx();
  master = audioCtx.createGain();
  master.gain.value = 0.9;
  master.connect(audioCtx.destination);
  return true;
}

function paintSound() {
  if (!soundToggle) return;
  const running = Boolean(audioCtx && audioCtx.state === "running");
  soundToggle.textContent = !soundOn ? "Sound off" : running ? "Sound on" : "Click for sound";
  soundToggle.setAttribute("aria-pressed", String(soundOn));
  soundToggle.classList.toggle("off", !soundOn);
}

function unlockAudio() {
  if (!soundOn || !ensureAudio()) return;
  if (audioCtx.state === "suspended") {
    audioCtx.resume().then(paintSound).catch(() => {});
  } else {
    paintSound();
  }
}

function blip(freq, { to = null, when = 0, dur = 0.14, gain = 0.05, type = "sine" } = {}) {
  const ctx = audioCtx;
  const start = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, start + dur);
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(env).connect(master);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

const SOUNDS = {
  pop() {
    const bend = 1 + Math.random() * 0.06;
    blip(520 * bend, { to: 780 * bend, dur: 0.1, gain: 0.055 });
  },
  chime() {
    const bend = 1 + (Math.random() - 0.5) * 0.04;
    blip(1046 * bend, { dur: 0.2, gain: 0.045 });
    blip(1568 * bend, { when: 0.065, dur: 0.24, gain: 0.03 });
  },
  twinkle() {
    const bend = 1 + (Math.random() - 0.5) * 0.06;
    blip(1318 * bend, { dur: 0.1, gain: 0.035, type: "triangle" });
    blip(1760 * bend, { when: 0.05, dur: 0.13, gain: 0.028, type: "triangle" });
  },
};

function playSound(name) {
  if (!soundOn) return;
  if (!ensureAudio() || audioCtx.state !== "running") return;
  const now = performance.now();
  if (now - lastTone < 90) return;
  lastTone = now;
  (SOUNDS[name] || SOUNDS.pop)();
}

const HOVER_SELECTOR =
  ".mascot-ring, .mascot, .bulb, .mug, .sparkle, .title-rule i, .rules span, .steps li, .corners svg, button";

function soundFor(el) {
  if (el.matches(".mascot-ring, .mascot, .mug, .corners svg")) return "chime";
  if (el.matches(".bulb, .sparkle, .title-rule i")) return "twinkle";
  return "pop";
}

function setupSound() {
  soundToggle = $("#sound-toggle");
  if (!soundToggle) return;

  soundToggle.addEventListener("click", () => {
    const running = Boolean(audioCtx && audioCtx.state === "running");
    soundOn = running ? !soundOn : true;
    if (soundOn) {
      unlockAudio();
      if (audioCtx) {
        audioCtx.resume()
          .then(() => {
            lastTone = 0;
            playSound("chime");
          })
          .catch(() => {});
      }
    }
    paintSound();
  });
  paintSound();

  for (const ev of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(ev, unlockAudio, { passive: true, once: true });
  }

  document.addEventListener(
    "pointerover",
    (event) => {
      if (event.pointerType === "touch") return;
      const target = event.target.closest(HOVER_SELECTOR);
      if (!target) return;
      if (event.relatedTarget && target.contains(event.relatedTarget)) return;
      playSound(soundFor(target));
    },
    { passive: true }
  );
}

/* ───────────────────────────── small helpers ───────────────────────────── */

function safeStorage() {
  const mem = new Map();
  try {
    const t = "__santa_test__";
    localStorage.setItem(t, t);
    localStorage.removeItem(t);
    return localStorage;
  } catch {
    return { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  }
}

function template(id) {
  return document.getElementById(id).content.cloneNode(true);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function setStatus(node, text, isError = false) {
  if (!node) return;
  node.textContent = text || "";
  node.classList.toggle("error", Boolean(isError));
}

async function busy(button, label, work) {
  const before = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = before;
  }
}

async function copy(text, button) {
  const before = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied ✓";
  } catch {
    const input = button.parentElement.querySelector("input");
    if (input) { input.focus(); input.select(); }
    button.textContent = "Press Ctrl/⌘+C";
  }
  setTimeout(() => (button.textContent = before), 1800);
}

function niceDate(iso, opts = { weekday: "long", month: "long", day: "numeric" }) {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, opts);
}

function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.round((new Date(`${iso}T12:00:00`) - today) / 864e5);
}

function giftDayLine(iso) {
  if (!iso) return `$${CAP_USD} max`;
  const n = daysUntil(iso);
  const when = n > 1 ? ` · ${n} days to go` : n === 1 ? " · tomorrow!" : n === 0 ? " · today! 🎄" : "";
  return `Gift day: ${niceDate(iso)}${when} · $${CAP_USD} max`;
}

const PREF = { handmade: "🎨 Would love something handmade", digital: "💳 Would love a digital gift", either: "✨ Happy with handmade or digital" };
const baseUrl = () => location.href.split("#")[0];
const joinLink = (code) => `${baseUrl()}#/join/${code}`;
const privateLink = (fragment) => `${baseUrl()}${fragment}`;

function readPerson(form) {
  const data = new FormData(form);
  return {
    name: String(data.get("name") || "").trim(),
    wishlist: String(data.get("wishlist") || "").trim(),
    giftPref: String(data.get("giftPref") || "either"),
  };
}

/* ───────────────────────────── saved groups (this device) ───────────────────────────── */

const SAVED = "secret-santa-groups-v1";
function savedGroups() {
  try { return JSON.parse(storage.getItem(SAVED)) || []; } catch { return []; }
}
function rememberGroup(entry) {
  const list = savedGroups().filter((g) => g.fragment !== entry.fragment);
  list.unshift({ ...entry, mode: db.mode });
  storage.setItem(SAVED, JSON.stringify(list.slice(0, 12)));
}
function forgetGroup(fragment) {
  storage.setItem(SAVED, JSON.stringify(savedGroups().filter((g) => g.fragment !== fragment)));
}

/* ───────────────────────────── views ───────────────────────────── */

function showMessage(text) {
  lede.textContent = "";
  const frag = template("tpl-message");
  $("[data-text]", frag).textContent = text;
  view.replaceChildren(frag);
}

function renderHome() {
  lede.textContent =
    "Draw names with your friends, wherever they are. Everyone signs up with one link, " +
    "gets a secret match, and sends a handmade or digital gift.";
  const frag = template("tpl-home");
  $("[data-person]", frag).append(template("tpl-person"));

  const mine = savedGroups().filter((g) => g.mode === db.mode);
  if (mine.length) {
    $("[data-my-groups]", frag).hidden = false;
    const list = $("[data-list]", frag);
    for (const g of mine) {
      const x = el("button", { type: "button", class: "chip-x", "aria-label": `Remove ${g.title} from this device` }, "✕");
      const li = el("li", {}, el("a", { href: g.fragment }, el("b", {}, g.title), ` · as ${g.name}`), x);
      x.addEventListener("click", () => {
        if (!x.dataset.armed) {
          x.dataset.armed = "1";
          x.textContent = "remove?";
          return;
        }
        forgetGroup(g.fragment);
        li.remove();
        if (!list.children.length) $("[data-my-groups]").hidden = true;
      });
      list.append(li);
    }
  }

  const form = $("[data-create]", frag);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("[data-status]", form);
    const title = String(new FormData(form).get("title") || "").trim();
    const giftDay = String(new FormData(form).get("giftDay") || "");
    const person = readPerson(form);
    if (!title) return setStatus(status, "Give your group a name first.", true);
    if (!person.name) return setStatus(status, "Add your name so your friends know it's you.", true);
    const button = $("button[type=submit]", form);
    try {
      const made = await busy(button, "Starting…", () => createGroup(db, { title, giftDay, ...person }));
      rememberGroup({ fragment: made.fragment, title, name: person.name });
      storage.setItem("secret-santa-fresh", made.fragment);
      location.hash = made.fragment;
    } catch (err) {
      setStatus(status, err.message, true);
    }
  });
  view.replaceChildren(frag);
}

async function renderJoin(code) {
  lede.textContent = "";
  view.replaceChildren(el("p", { class: "loading" }, "Finding your group…"));
  let preview;
  try {
    preview = await db.eventPreview(code);
  } catch (err) {
    return showMessage(err.message);
  }
  const frag = template("tpl-join");
  $("[data-title]", frag).textContent = preview.title;
  $("[data-meta]", frag).textContent = giftDayLine(preview.gift_day);
  $("[data-count]", frag).textContent = `(${preview.names.length})`;
  const names = $("[data-names]", frag);
  for (const n of preview.names) names.append(el("li", {}, n));
  $("[data-person]", frag).append(template("tpl-person"));

  const form = $("[data-join]", frag);
  if (preview.status !== "open") {
    $("[data-closed]", frag).hidden = false;
    form.hidden = true;
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("[data-status]", form);
    const person = readPerson(form);
    if (!person.name) return setStatus(status, "Add your name so your friends know it's you.", true);
    const button = $("button[type=submit]", form);
    try {
      const joined = await busy(button, "Joining…", () => joinGroup(db, code, person));
      rememberGroup({ fragment: joined.fragment, title: preview.title, name: person.name });
      storage.setItem("secret-santa-fresh", joined.fragment);
      location.hash = joined.fragment;
    } catch (err) {
      setStatus(status, err.message, true);
    }
  });
  view.replaceChildren(frag);
}

/* ───────────────────────────── my page ───────────────────────────── */

async function renderMe(fragment, { quiet = false } = {}) {
  const secret = parsePrivateFragment(fragment);
  if (!secret) return showMessage("That private link looks incomplete. Try copying the whole link again.");
  if (!quiet) {
    lede.textContent = "";
    view.replaceChildren(el("p", { class: "loading" }, "Opening your page…"));
  }

  let state;
  try {
    state = await loadMe(db, secret);
  } catch (err) {
    const saved = savedGroups().some((g) => g.fragment === fragment);
    showMessage(saved && /not valid/.test(err.message)
      ? "This group doesn't exist anymore. It may have been deleted by the person who started it."
      : err.message);
    if (saved) {
      const b = el("button", { type: "button", class: "secondary" }, "Remove it from this device");
      b.addEventListener("click", () => { forgetGroup(fragment); location.hash = "#/"; });
      $(".actions", view).prepend(b);
    }
    return;
  }
  const { event, me } = state;
  rememberGroup({ fragment, title: event.title, name: me.name });
  document.title = `${event.title} · Secret Santa`;

  const frag = template("tpl-me");
  $("[data-name]", frag).textContent = me.name;
  $("[data-title]", frag).textContent = event.title;
  $("[data-meta]", frag).textContent = giftDayLine(event.gift_day);
  for (const input of $$("[data-private-link]", frag)) input.value = privateLink(fragment);
  for (const b of $$("[data-copy-private]", frag)) b.addEventListener("click", () => copy(privateLink(fragment), b));

  if (storage.getItem("secret-santa-fresh") === fragment) {
    const box = $("[data-fresh]", frag);
    box.hidden = false;
    $("[data-saved]", box).addEventListener("click", () => {
      storage.removeItem ? storage.removeItem("secret-santa-fresh") : storage.setItem("secret-santa-fresh", "");
      box.hidden = true;
    });
  }

  if (event.status === "open") fillLobby(frag, state, secret, fragment);
  else fillDrawn(frag, state, secret, fragment);
  fillWishEditor(frag, state, secret);

  if (me.is_owner) fillSettings(frag, state, secret, fragment);
  $("[data-refresh]", frag).addEventListener("click", () => renderMe(fragment));
  $("[data-forget]", frag).addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed) {
      forgetGroup(fragment);
      location.hash = "#/";
    } else {
      b.dataset.armed = "1";
      b.textContent = "Sure? Save your link first! Tap again";
    }
  });

  // keep scroll position on quiet refreshes
  const y = window.scrollY;
  view.replaceChildren(frag);
  if (quiet) window.scrollTo(0, y);

  clearTimeout(pollTimer);
  if (event.status === "open") {
    pollTimer = setTimeout(() => {
      if (location.hash === fragment && !document.hidden && !view.contains(document.activeElement)) {
        renderMe(fragment, { quiet: true });
      } else if (location.hash === fragment) {
        pollTimer = setTimeout(() => renderMe(fragment, { quiet: true }), 20000);
      }
    }, 15000);
  }
}

function fillLobby(frag, state, secret, fragment) {
  const { event, me, participants } = state;
  lede.textContent = "Share the join link with your friends. Once everyone's in, names get drawn.";
  const lobby = $("[data-lobby]", frag);
  lobby.hidden = false;
  $("[data-count]", lobby).textContent = `(${participants.length})`;
  $("[data-join-link]", lobby).value = joinLink(event.code);
  const copyJoin = $("[data-copy-join]", lobby);
  copyJoin.addEventListener("click", () => copy(joinLink(event.code), copyJoin));

  const list = $("[data-people]", lobby);
  for (const p of participants) {
    const chip = el("li", { class: p.id === me.id ? "you" : "" }, p.name);
    if (p.is_owner) chip.append(el("span", { class: "star", title: "Started the group" }, " ★"));
    if (me.is_owner && p.id !== me.id) {
      const x = el("button", { type: "button", class: "chip-x", "aria-label": `Remove ${p.name}` }, "✕");
      x.addEventListener("click", async () => {
        if (!x.dataset.armed) {
          x.dataset.armed = "1";
          x.textContent = "remove?";
          return;
        }
        try {
          await db.removeParticipant(secret.token, p.id);
          renderMe(fragment, { quiet: true });
        } catch (err) {
          setStatus($("[data-draw-status]", lobby), err.message, true);
        }
      });
      chip.append(x);
    }
    list.append(chip);
  }

  if (me.is_owner) {
    const box = $("[data-owner-draw]", lobby);
    box.hidden = false;
    const button = $("[data-draw]", box);
    const status = $("[data-draw-status]", box);
    if (participants.length < 3) {
      button.disabled = true;
      setStatus(status, "You need at least 3 people to draw names.");
    }
    button.addEventListener("click", async () => {
      if (!button.dataset.armed) {
        button.dataset.armed = "1";
        button.textContent = `Is everyone here? Tap again to draw for ${participants.length} 🎲`;
        return;
      }
      try {
        await busy(button, "Drawing names…", () => drawNames(db, secret));
        renderMe(fragment);
      } catch (err) {
        setStatus(status, err.message, true);
      }
    });
  } else {
    const waiting = $("[data-waiting]", lobby);
    waiting.hidden = false;
    const owner = participants.find((p) => p.is_owner);
    $("[data-owner]", waiting).textContent = owner ? owner.name : "the organiser";
  }
}

function fillDrawn(frag, state, secret, fragment) {
  const { event, match } = state;
  lede.textContent = "Names are drawn! Your match is secret. Only you can see it.";
  const panel = $("[data-match]", frag);
  panel.hidden = false;

  if (!match || match.error) {
    $("[data-envelope]", panel).hidden = true;
    const msg = $("[data-match-error]", panel);
    msg.hidden = false;
    msg.textContent = (match && match.error) || "We couldn't find your match.";
  } else {
    $("[data-match-name]", panel).textContent = match.name;
    const wish = $("[data-match-wish]", panel);
    wish.textContent = match.wishlist || `${match.name} didn't write a wishlist. Surprise them! 🎲`;
    wish.classList.toggle("muted", !match.wishlist);
    $("[data-match-pref]", panel).textContent = PREF[match.gift_pref] || "";
    if (event.gift_day) {
      const gd = $("[data-giftday]", panel);
      gd.hidden = false;
      gd.textContent = `Gift day: ${niceDate(event.gift_day, { month: "long", day: "numeric" })}`;
    }
    const seenKey = `secret-santa-opened:${secret.token.slice(0, 12)}`;
    // the gift form names the match, so it only appears once the envelope is open
    const sendBox = $("[data-send]", frag);
    const reveal = () => {
      $("[data-envelope]", panel).hidden = true;
      $("[data-match-card]", panel).hidden = false;
      sendBox.hidden = Boolean(match.left);
    };
    if (!match.left) fillSend(frag, state, secret, fragment);
    if (storage.getItem(seenKey)) reveal();
    $("[data-envelope]", panel).addEventListener("click", (e) => {
      e.currentTarget.classList.add("opening");
      storage.setItem(seenKey, "1");
      setTimeout(reveal, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650);
    });
  }
  fillInbox(frag, state, secret, fragment);
}

function fillSend(frag, state, secret, fragment) {
  const { match, sent } = state;
  const box = $("[data-send]", frag);
  $("[data-to]", box).textContent = match.name;
  const form = $("[data-gift]", box);
  const status = $("[data-gift-status]", box);
  let kind = "giftcard";
  let image = "";

  const noteHint = $("[data-note-hint]", form);
  for (const tab of $$("[data-kind]", box)) {
    tab.addEventListener("click", () => {
      kind = tab.dataset.kind;
      for (const t of $$("[data-kind]", box)) t.setAttribute("aria-selected", String(t === tab));
      for (const part of $$("[data-for]", form)) part.hidden = part.dataset.for !== kind;
      noteHint.textContent = kind === "note" ? "a few kind words" : "optional";
      setStatus(status, "");
    });
  }

  const amount = form.elements.amount;
  amount.addEventListener("input", () => ($("[data-cap-warn]", form).hidden = !overCap(amount.value)));

  const preview = $("[data-preview]", form);
  form.elements.image.addEventListener("change", async () => {
    const file = form.elements.image.files[0];
    image = "";
    preview.hidden = true;
    if (!file) return;
    try {
      setStatus(status, "Getting your drawing ready…");
      image = await shrinkImage(file);
      preview.src = image;
      preview.hidden = false;
      setStatus(status, "");
    } catch {
      setStatus(status, "That file couldn't be read as a picture. Try a PNG or JPG.", true);
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = form.elements;
    const input =
      kind === "giftcard"
        ? { kind, store: f.store.value, amount: f.amount.value, code: f.code.value, link: f.link.value, message: f.message.value }
        : kind === "art"
          ? { kind, image, link: f.artLink.value, message: f.message.value }
          : { kind, message: f.message.value };
    if (kind === "giftcard" && overCap(f.amount.value)) {
      return setStatus(status, `Please keep it to $${CAP_USD} or less.`, true);
    }
    const button = $("button[type=submit]", form);
    try {
      await busy(button, "Wrapping…", () => sendGift(db, secret, match, input));
      form.reset();
      image = "";
      preview.hidden = true;
      await renderMe(fragment, { quiet: true });
      setStatus($("[data-gift-status]"), `Sent! 🎀 It's under ${match.name}'s tree, wrapped until gift day.`);
    } catch (err) {
      setStatus(status, err.message, true);
    }
  });

  if (sent.length) {
    $("[data-sent]", box).hidden = false;
    const list = $("[data-sent-list]", box);
    for (const g of sent) {
      const who = g.recipient ? g.recipient.name : "someone";
      const li = el(
        "li",
        { class: "gift-row" },
        el("span", { class: "gift-icon", "aria-hidden": "true" }, g.opened_at ? "💝" : "🎁"),
        el("span", { class: "gift-text" }, `To ${who} · sent ${niceDate(g.sent_at.slice(0, 10), { month: "short", day: "numeric" })}`),
        el("span", { class: g.opened_at ? "badge open" : "badge" }, g.opened_at ? "Opened ✓" : "Wrapped")
      );
      if (!g.opened_at) {
        const back = el("button", { type: "button", class: "secondary small" }, "Take back");
        back.addEventListener("click", async () => {
          if (!back.dataset.armed) {
            back.dataset.armed = "1";
            back.textContent = "Sure?";
            return;
          }
          try {
            await db.unsendGift(secret.token, g.id);
            renderMe(fragment, { quiet: true });
          } catch (err) {
            setStatus(status, err.message, true);
          }
        });
        li.append(back);
      }
      list.append(li);
    }
  }
}

function fillInbox(frag, state, secret, fragment) {
  const { event, received } = state;
  const box = $("[data-inbox]", frag);
  box.hidden = false;
  const note = $("[data-inbox-note]", box);
  const list = $("[data-inbox-list]", box);

  if (!received.length) {
    note.textContent = "Nothing yet. Your Secret Santa is still busy in the workshop. 🧑‍🎄";
    return;
  }
  if (!event.gifts_open) {
    const n = received.length;
    note.textContent = `${n} ${n === 1 ? "gift is" : "gifts are"} waiting for you! ${n === 1 ? "It unwraps" : "They unwrap"} on ${niceDate(event.gift_day)}. No peeking. 👀`;
    for (let i = 0; i < n; i++) list.append(el("li", { class: "gift wrapped" }, el("span", { class: "gift-box", "aria-hidden": "true" }, "🎁")));
    return;
  }
  note.textContent = "Gift day is here! 🎄";
  for (const g of received) list.append(giftCard(g, secret, fragment));
}

function giftCard(g, secret, fragment) {
  const li = el("li", { class: "gift" });
  if (!g.opened_at) {
    const b = el("button", { type: "button", class: "unwrap" }, el("span", { class: "gift-box", "aria-hidden": "true" }, "🎁"), " Unwrap");
    b.addEventListener("click", async () => {
      li.classList.add("unwrapping");
      try { await db.openGift(secret.token, g.id); } catch { /* opening still works locally */ }
      li.replaceWith(giftCard({ ...g, opened_at: new Date().toISOString() }, secret, fragment));
    });
    li.append(b);
    return li;
  }

  const gift = g.gift || { kind: "note", message: "" };
  const body = el("div", { class: "gift-body" });
  if (gift.kind === "giftcard") {
    const title = [gift.store, gift.amount ? `$${gift.amount}` : ""].filter(Boolean).join(" · ") || "Gift card";
    body.append(el("p", { class: "gift-title" }, `💳 ${title}`));
    if (gift.code) {
      const row = el("div", { class: "copy-row" }, el("input", { type: "text", readonly: "", value: gift.code, "aria-label": "Gift card code" }));
      const c = el("button", { type: "button", class: "small" }, "Copy code");
      c.addEventListener("click", () => copy(gift.code, c));
      row.append(c);
      body.append(row);
    }
  } else if (gift.kind === "art") {
    body.append(el("p", { class: "gift-title" }, "🎨 A drawing, just for you"));
    if (gift.image && gift.image.startsWith("data:image/")) body.append(el("img", { class: "art", src: gift.image, alt: "A drawing from your Secret Santa" }));
  } else {
    body.append(el("p", { class: "gift-title" }, "💌 A note"));
  }
  if (gift.link && /^https?:\/\//i.test(gift.link)) {
    body.append(el("p", {}, el("a", { href: gift.link, target: "_blank", rel: "noopener noreferrer" }, gift.kind === "giftcard" ? "Redeem it here ↗" : "Open the link ↗")));
  }
  if (gift.message) body.append(el("p", { class: "gift-message" }, gift.message));
  body.append(el("p", { class: "from" }, "— your Secret Santa ❄️"));
  li.append(body);
  return li;
}

function fillSettings(frag, state, secret, fragment) {
  const box = $("[data-settings]", frag);
  box.hidden = false;
  const button = $("[data-delete]", box);
  const status = $("[data-delete-status]", box);
  button.addEventListener("click", async () => {
    if (!button.dataset.armed) {
      button.dataset.armed = "1";
      button.textContent = `Really delete "${state.event.title}" for everyone? Tap again`;
      return;
    }
    try {
      await busy(button, "Deleting…", () => db.deleteEvent(secret.token));
      forgetGroup(fragment);
      clearTimeout(pollTimer);
      showMessage(`"${state.event.title}" has been deleted. 🧹`);
    } catch (err) {
      setStatus(status, err.message, true);
    }
  });
}

function fillWishEditor(frag, state, secret) {
  const { me, event } = state;
  const form = $("[data-wish]", frag);
  form.elements.wishlist.value = me.wishlist;
  for (const r of form.elements.giftPref) r.checked = r.value === me.gift_pref;
  if (event.status === "open" && !me.wishlist) $("[data-edit]", frag).open = true;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("[data-wish-status]", form);
    const button = $("button[type=submit]", form);
    try {
      await busy(button, "Saving…", () => db.updateMe(secret.token, form.elements.wishlist.value.trim(), form.elements.giftPref.value));
      setStatus(status, "Saved! Your Secret Santa will see the new version.");
    } catch (err) {
      setStatus(status, err.message, true);
    }
  });
}

/** Resize a picture to at most 1000px and JPEG it, staying under ~450 KB. */
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  let max = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.85);
    if (url.length < 450000) return url;
    max = Math.round(max * 0.75);
  }
  throw new Error("Picture too large");
}

/* ───────────────────────────── snow ───────────────────────────── */

const SNOW_TONES = ["#ffffff", "#fffdf6", "#f4f8fb", "#e6f0f7", "#fbf5e9", "#f3dfa6"];

function snowTier() {
  const roll = Math.random();
  if (roll < 0.3) return { cls: "far", min: 6, span: 3, dur: 20, fade: 0.45 };
  if (roll > 0.78) return { cls: "near", min: 16, span: 6, dur: 8, fade: 0.9 };
  return { cls: "mid", min: 10, span: 4, dur: 13, fade: 0.7 };
}

function snowFlakeSvg(shape) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${shape}`);
  svg.appendChild(use);
  return svg;
}

function addSnow() {
  const layer = $("#snow");
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 36; i++) {
    const tier = snowTier();
    const size = tier.min + Math.random() * tier.span;
    const flake = document.createElement("i");
    flake.className = tier.cls === "mid" ? "flake" : `flake ${tier.cls}`;
    flake.style.setProperty("--x", `${Math.random() * 100}vw`);
    flake.style.setProperty("--size", `${size}px`);
    flake.style.setProperty("--dur", `${tier.dur + Math.random() * 7}s`);
    flake.style.setProperty("--delay", `${-Math.random() * 24}s`);
    flake.style.setProperty("--drift", `${-24 + Math.random() * 60}px`);
    flake.style.setProperty("--sway-dur", `${3 + Math.random() * 4}s`);
    flake.style.setProperty("--tone", SNOW_TONES[Math.floor(Math.random() * SNOW_TONES.length)]);
    flake.style.setProperty("--opacity", `${tier.fade + Math.random() * 0.15}`);
    const spin = document.createElement("span");
    spin.className = "spin";
    const shape = size < 8 ? "flake-simple" : Math.random() < 0.6 ? "flake-classic" : "flake-crystal";
    const svg = snowFlakeSvg(shape);
    svg.style.transform = `rotate(${Math.round(Math.random() * 60)}deg)`;
    spin.appendChild(svg);
    flake.appendChild(spin);
    frag.appendChild(flake);
  }
  layer.appendChild(frag);
}

/* ───────────────────────────── router ───────────────────────────── */

function route() {
  clearTimeout(pollTimer);
  document.title = "Secret Santa ✨ a cozy little holiday ritual";
  const hash = location.hash;
  if (hash.startsWith("#/me/")) return renderMe(hash);
  const join = /^#\/join\/([A-Za-z0-9_-]{4,40})$/.exec(hash);
  if (join) return renderJoin(join[1]);
  if (/^#k=/.test(hash)) {
    return showMessage("This is a link from the old version of the app, which worked differently. Ask your group for the new join link!");
  }
  renderHome();
}

$("#demo-banner").hidden = db.mode !== "demo";
setupSound();
addSnow();
window.addEventListener("hashchange", () => {
  route();
  window.scrollTo(0, 0);
});
route();
