/**
 * Public-key "sealed envelopes" for the sign-up version of the app.
 *
 * Each person gets an ECDH P-256 keypair in their own browser when they join.
 * The public half is uploaded; the private half lives only in their private
 * link (the URL fragment, which browsers never send to a server).
 *
 * seal(text, publicJwk)  -> a string only the matching private key can open.
 * Under the hood: a throwaway ECDH key + HKDF-SHA-256 -> AES-256-GCM
 * (the standard ECIES construction), all with built-in Web Crypto.
 *
 * Works in browsers and in Node 20+ (both expose globalThis.crypto).
 */

import { toBase64Url, fromBase64Url } from "./crypto.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const CURVE = { name: "ECDH", namedCurve: "P-256" };
const INFO = enc.encode("secret-santa seal v1");
const VERSION = "s1";

/** A fresh random secret, used as a person's sign-in token. */
export function newToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

/** Make a keypair. Returns JWKs: publicKey to upload, privateKey to keep. */
export async function newKeyPair() {
  const pair = await crypto.subtle.generateKey(CURVE, true, ["deriveBits"]);
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    publicKey: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y },
    privateKey: { kty: "EC", crv: "P-256", x: priv.x, y: priv.y, d: priv.d },
  };
}

async function aesKey(privateKey, publicKey, salt) {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: INFO },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function importPublic(jwk) {
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, CURVE, false, []);
}

function importPrivate(jwk) {
  return crypto.subtle.importKey("jwk", { ...jwk, kty: "EC", crv: "P-256" }, CURVE, false, ["deriveBits"]);
}

/** Encrypt text so only the holder of the matching private key can read it. */
export async function seal(text, recipientPublicJwk) {
  const recipient = await importPublic(recipientPublicJwk);
  const eph = await crypto.subtle.generateKey(CURVE, true, ["deriveBits"]);
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(eph.privateKey, recipient, ephRaw);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text)));
  return [VERSION, toBase64Url(ephRaw), toBase64Url(iv), toBase64Url(ct)].join(".");
}

/** Open a sealed string with your private key. Throws if it isn't for you. */
export async function open(sealed, privateJwk) {
  const [version, ephPart, ivPart, ctPart] = String(sealed).split(".");
  if (version !== VERSION || !ephPart || !ivPart || !ctPart) throw new Error("Not a sealed message");
  const ephRaw = fromBase64Url(ephPart);
  const eph = await crypto.subtle.importKey("raw", ephRaw, CURVE, false, []);
  const key = await aesKey(await importPrivate(privateJwk), eph, ephRaw);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivPart) }, key, fromBase64Url(ctPart));
  return dec.decode(plain);
}

/**
 * Private links: "#/me/<token>.<x>.<y>.<d>" — everything needed to sign in
 * and decrypt, and nothing a server ever sees.
 */
export function privateFragment(token, privateJwk) {
  return `#/me/${token}.${privateJwk.x}.${privateJwk.y}.${privateJwk.d}`;
}

export function parsePrivateFragment(hash) {
  const m = /^#\/me\/([A-Za-z0-9_-]{20,})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(
    String(hash || "")
  );
  if (!m) return null;
  return { token: m[1], privateKey: { kty: "EC", crv: "P-256", x: m[2], y: m[3], d: m[4] } };
}
