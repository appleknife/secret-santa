import { makeAssignments, parseNames, parseExclusions } from "./assign.js";
import {
  newKey,
  encryptText,
  decryptText,
  revealLink,
  parseRevealHash,
} from "./crypto.js";

const $ = (id) => document.getElementById(id);

function row(giver, link) {
  const tr = document.createElement("tr");
  const name = document.createElement("td");
  name.textContent = giver;

  const cell = document.createElement("td");
  const button = document.createElement("button");
  button.textContent = "Copy link";
  button.className = "copy";
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(link);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy link"), 1500);
  });
  cell.appendChild(button);

  tr.append(name, cell);
  return tr;
}

async function generate() {
  const status = $("status");
  const results = $("results");
  const names = parseNames($("names").value);
  const exclusions = parseExclusions($("exclusions").value);

  results.replaceChildren();
  status.className = "status";

  try {
    const assignments = makeAssignments(names, exclusions);
    const base = location.href.split("#")[0];

    for (const [giver, receiver] of assignments) {
      const key = newKey();
      const cipher = await encryptText(receiver, key);
      results.appendChild(row(giver, revealLink(base, key, cipher)));
    }

    status.textContent = `${assignments.size} links generated. Send each person only their own.`;
  } catch (error) {
    status.textContent = error.message;
    status.className = "status error";
  }
}

async function showReveal() {
  const payload = parseRevealHash(location.hash);
  if (!payload) return;

  $("organizer").hidden = true;
  $("reveal").hidden = false;

  try {
    $("match").textContent = await decryptText(payload.cipher, payload.key);
  } catch {
    $("match").textContent = "This link is damaged or incomplete.";
  }
}

$("generate").addEventListener("click", generate);
$("start-over").addEventListener("click", () => {
  location.hash = "";
  location.reload();
});

showReveal();
