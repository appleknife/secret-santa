import { makeAssignments, parseNames, parseExclusions } from "./assign.js";
import {
  newKey,
  encryptText,
  decryptText,
  revealLink,
  parseRevealHash,
} from "./crypto.js";

const $ = (id) => document.getElementById(id);
const CAP = 20;
const wishes = new Map();
let generated = [];

const SNOW_TONES = ["#fffdfb", "#e8f2fb", "#c3dcec", "#bcdccb", "#eec0cb", "#f0dca8"];

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
  const layer = $("snow");
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

function renderWishFields() {
  const names = parseNames($("names").value);
  const host = $("wish-fields");
  host.replaceChildren();

  if (names.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Add names above to write a private hint for each person.";
    host.appendChild(p);
    return;
  }

  const fieldset = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Little hints — only their Santa sees them";
  fieldset.appendChild(legend);

  for (const name of names) {
    const row = document.createElement("label");
    row.className = "wish-row";
    const label = document.createElement("span");
    label.textContent = name;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "e.g. cosy socks, art supplies, no chocolate";
    input.value = wishes.get(name) || "";
    input.addEventListener("input", () => wishes.set(name, input.value));
    row.append(label, input);
    fieldset.appendChild(row);
  }
  host.appendChild(fieldset);
}

function makeRow(giver, link) {
  const tr = document.createElement("tr");
  const name = document.createElement("td");
  name.textContent = giver;

  const cell = document.createElement("td");
  const button = document.createElement("button");
  button.className = "secondary small copy";
  button.textContent = "Copy link";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select & copy";
      const range = document.createRange();
      range.selectNodeContents(button);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    setTimeout(() => (button.textContent = "Copy link"), 1600);
  });
  cell.appendChild(button);
  tr.append(name, cell);
  return tr;
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function downloadCsv() {
  const lines = [["Giver", "Private link"], ...generated.map((r) => [r.giver, r.link])];
  const csv = lines.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "secret-santa-links.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function generate() {
  const status = $("status");
  const results = $("results");
  $("results-wrap").classList.add("hidden");
  $("download").classList.add("hidden");
  results.replaceChildren();
  status.className = "status";
  status.textContent = "";

  const names = parseNames($("names").value);
  const exclusions = parseExclusions($("exclusions").value);
  const title = $("event-name").value.trim() || "Secret Santa";
  const date = $("exchange-date").value;

  try {
    const assignments = makeAssignments(names, exclusions);
    const base = location.href.split("#")[0];
    generated = [];

    for (const [giver, receiver] of assignments) {
      const key = newKey();
      const payload = JSON.stringify({
        receiver,
        title,
        date,
        cap: CAP,
        hint: wishes.get(receiver) || "",
      });
      const cipher = await encryptText(payload, key);
      const link = revealLink(base, key, cipher);
      generated.push({ giver, link });
      results.appendChild(makeRow(giver, link));
    }

    $("results-wrap").classList.remove("hidden");
    $("download").classList.remove("hidden");
    status.textContent = `${assignments.size} secret links ready. Send each person only their own.`;
  } catch (error) {
    generated = [];
    status.textContent = error.message;
    status.className = "status error";
  }
}

function prettyDate(value) {
  if (!value) return "";
  const day = new Date(`${value}T00:00:00`);
  if (Number.isNaN(day.getTime())) return value;
  return day.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

async function showReveal() {
  const payload = parseRevealHash(location.hash);
  if (!payload) return;

  $("organizer").classList.add("hidden");
  $("reveal").classList.remove("hidden");

  try {
    const plain = await decryptText(payload.cipher, payload.key);
    let data;
    try {
      data = JSON.parse(plain);
    } catch {
      data = { receiver: plain };
    }

    $("match").textContent = data.receiver || "?";
    const hint = data.hint || "";
    $("letter").hidden = !hint;
    $("hint-text").textContent = hint;

    const day = $("reveal-day");
    day.hidden = !data.date;
    day.textContent = data.date ? `Gift day: ${prettyDate(data.date)}` : "";
    document.title = `${data.receiver} — Secret Santa`;
  } catch {
    $("match").textContent = "This link is damaged or incomplete.";
    $("letter").hidden = true;
  }
}

$("names").addEventListener("input", renderWishFields);
$("generate").addEventListener("click", generate);
$("download").addEventListener("click", downloadCsv);
$("start-over").addEventListener("click", () => {
  location.hash = "";
  location.reload();
});

addSnow();
renderWishFields();
showReveal();
