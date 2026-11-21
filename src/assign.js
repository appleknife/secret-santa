/**
 * Assignment logic: a derangement (nobody draws themselves) that also respects
 * exclusions (e.g. couples who shouldn't draw each other).
 *
 * Pure function, no browser APIs — that's what makes it testable.
 */

const SEP = "\u0000";

/**
 * @param {string[]} names  participants, trimmed, unique
 * @param {[string,string][]} exclusions  pairs that must not draw each other
 * @param {() => number} rng  injectable for deterministic tests
 * @returns {Map<string,string>} giver -> receiver
 */
export function makeAssignments(names, exclusions = [], rng = Math.random) {
  const clean = (names || []).map((n) => String(n).trim()).filter(Boolean);

  if (clean.length < 2) throw new Error("Need at least 2 participants");
  if (new Set(clean).size !== clean.length) throw new Error("Duplicate names");

  const blocked = new Set();
  for (const pair of exclusions || []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [a, b] = pair.map((x) => String(x).trim());
    if (!clean.includes(a) || !clean.includes(b) || a === b) continue;
    blocked.add(a + SEP + b);
    blocked.add(b + SEP + a);
  }

  const givers = [...clean];
  const remaining = new Set(clean);
  const result = new Map();

  const allowed = (giver, receiver) =>
    giver !== receiver && !blocked.has(giver + SEP + receiver);

  function search() {
    if (result.size === givers.length) return true;

    // Pick the giver with the fewest remaining options — keeps the search small.
    let pick = null;
    let options = null;
    for (const giver of givers) {
      if (result.has(giver)) continue;
      const o = [...remaining].filter((r) => allowed(giver, r));
      if (o.length === 0) return false;
      if (!pick || o.length < options.length) {
        pick = giver;
        options = o;
      }
    }

    // Shuffle so repeated runs don't produce the same pairing.
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }

    for (const receiver of options) {
      result.set(pick, receiver);
      remaining.delete(receiver);
      if (search()) return true;
      result.delete(pick);
      remaining.add(receiver);
    }
    return false;
  }

  if (!search()) {
    throw new Error("No valid assignment exists with these exclusions");
  }
  return result;
}

/** Parse "A - B" lines into pairs. */
export function parseExclusions(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.split(/\s*[-–>]+\s*/).map((s) => s.trim()).filter(Boolean))
    .filter((parts) => parts.length === 2);
}

/** Parse a newline-separated participant list. */
export function parseNames(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
