import test from "node:test";
import assert from "node:assert/strict";
import {
  newKey,
  encryptText,
  decryptText,
  revealLink,
  parseRevealHash,
} from "../src/crypto.js";

test("round trip", async () => {
  const key = newKey();
  const cipher = await encryptText("You draw Cleo", key);
  assert.equal(await decryptText(cipher, key), "You draw Cleo");
});

test("wrong key fails instead of returning garbage", async () => {
  const cipher = await encryptText("secret", newKey());
  await assert.rejects(() => decryptText(cipher, newKey()));
});

test("same plaintext encrypts differently each time", async () => {
  const key = newKey();
  const a = await encryptText("Ben", key);
  const b = await encryptText("Ben", key);
  assert.notEqual(a, b, "IV should make ciphertexts differ");
});

test("links round-trip through the fragment", async () => {
  const key = newKey();
  const cipher = await encryptText("You draw Fay", key);
  const link = revealLink("https://example.github.io/secret-santa/", key, cipher);
  assert.ok(link.includes("#k="), "fragment should carry the key");

  const parsed = parseRevealHash(new URL(link).hash);
  assert.deepEqual(parsed, { key, cipher });
  assert.equal(await decryptText(parsed.cipher, parsed.key), "You draw Fay");
});

test("no hash means no payload", () => {
  assert.equal(parseRevealHash(""), null);
  assert.equal(parseRevealHash("#k=abc"), null);
});
