import test from "node:test";
import assert from "node:assert/strict";
import { makeAssignments, parseExclusions, parseNames } from "../src/assign.js";

const names = ["Ana", "Ben", "Cleo", "Dev", "Eli", "Fay"];

test("every participant gives exactly once and receives exactly once", () => {
  const result = makeAssignments(names);
  assert.equal(result.size, names.length);
  assert.deepEqual([...result.keys()].sort(), [...names].sort());
  assert.deepEqual([...result.values()].sort(), [...names].sort());
});

test("nobody draws themselves", () => {
  for (let run = 0; run < 50; run++) {
    for (const [giver, receiver] of makeAssignments(names)) {
      assert.notEqual(giver, receiver, `${giver} drew themselves`);
    }
  }
});

test("exclusions are respected, both directions", () => {
  const exclusions = [
    ["Ana", "Ben"],
    ["Cleo", "Dev"],
  ];
  for (let run = 0; run < 50; run++) {
    const result = makeAssignments(names, exclusions);
    assert.notEqual(result.get("Ana"), "Ben");
    assert.notEqual(result.get("Ben"), "Ana");
    assert.notEqual(result.get("Cleo"), "Dev");
    assert.notEqual(result.get("Dev"), "Cleo");
  }
});

test("results vary between runs", () => {
  const seen = new Set();
  for (let run = 0; run < 20; run++) {
    seen.add([...makeAssignments(names)].map(([g, r]) => `${g}>${r}`).join(","));
  }
  assert.ok(seen.size > 1, "assignments never changed between runs");
});

test("impossible constraints are rejected instead of looping forever", () => {
  assert.throws(() => makeAssignments(["Ana", "Ben"], [["Ana", "Ben"]]), /No valid assignment/);
  assert.throws(() => makeAssignments(["Ana"]), /at least 2/);
  assert.throws(() => makeAssignments(["Ana", "Ana"]), /Duplicate/);
});

test("four people with one exclusion works", () => {
  const result = makeAssignments(["Ana", "Ben", "Cleo", "Dev"], [["Ana", "Ben"]]);
  assert.equal(result.size, 4);
  assert.notEqual(result.get("Ana"), "Ben");
  assert.notEqual(result.get("Ben"), "Ana");
});

test("an exclusion that makes a solution impossible is rejected, not fudged", () => {
  // Ana and Ben may only draw Cleo, so two people compete for one name.
  assert.throws(() => makeAssignments(["Ana", "Ben", "Cleo"], [["Ana", "Ben"]]), /No valid assignment/);
});

test("parsers", () => {
  assert.deepEqual(parseNames("Ana\n\n Ben \n"), ["Ana", "Ben"]);
  assert.deepEqual(parseExclusions("Ana - Ben\nCleo -> Dev\nbroken"), [
    ["Ana", "Ben"],
    ["Cleo", "Dev"],
  ]);
});
