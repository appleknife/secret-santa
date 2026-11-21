import test from "node:test";
import assert from "node:assert/strict";
import { newKeyPair, newToken, seal, open, privateFragment, parsePrivateFragment } from "../src/keys.js";

test("seal/open round trip, including emoji and long text", async () => {
  const { publicKey, privateKey } = await newKeyPair();
  const text = "🎁 Steam card XXXX-YYYY-ZZZZ " + "✨".repeat(2000);
  assert.equal(await open(await seal(text, publicKey), privateKey), text);
});

test("someone else's private key cannot open it", async () => {
  const alice = await newKeyPair();
  const bob = await newKeyPair();
  const sealed = await seal("for Alice only", alice.publicKey);
  await assert.rejects(() => open(sealed, bob.privateKey));
});

test("same text seals differently every time", async () => {
  const { publicKey } = await newKeyPair();
  assert.notEqual(await seal("Ben", publicKey), await seal("Ben", publicKey));
});

test("tampering is detected", async () => {
  const { publicKey, privateKey } = await newKeyPair();
  const sealed = await seal("hello", publicKey);
  const parts = sealed.split(".");
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA");
  await assert.rejects(() => open(parts.join("."), privateKey));
});

test("public key never contains the private part", async () => {
  const { publicKey } = await newKeyPair();
  assert.equal(publicKey.d, undefined);
  assert.equal(publicKey.x.length, 43);
});

test("private link fragment round-trips and rejects junk", async () => {
  const { privateKey, publicKey } = await newKeyPair();
  const token = newToken();
  const parsed = parsePrivateFragment(privateFragment(token, privateKey));
  assert.equal(parsed.token, token);
  assert.equal(await open(await seal("ok", publicKey), parsed.privateKey), "ok");
  assert.equal(parsePrivateFragment("#/me/short.x.y.z"), null);
  assert.equal(parsePrivateFragment("#k=abc&c=def"), null);
  assert.equal(parsePrivateFragment(""), null);
});
