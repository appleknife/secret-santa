/**
 * Encrypted reveal links.
 *
 * Each participant gets a URL whose *fragment* holds a random 256-bit key.
 * Fragments are never sent to a server, so a static host (GitHub Pages) can
 * hand out per-person secrets without ever knowing them.
 *
 * Works in the browser and in Node (both expose Web Crypto as globalThis.crypto).
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const IV_BYTES = 12;

export function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A fresh 256-bit key, URL-safe. */
export function newKey() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function importKey(keyB64, usage) {
  return crypto.subtle.importKey("raw", fromBase64Url(keyB64), "AES-GCM", false, [usage]);
}

/** Encrypt text -> "iv.ciphertext", both base64url. */
export async function encryptText(plainText, keyB64) {
  const key = await importKey(keyB64, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(plainText))
  );
  return `${toBase64Url(iv)}.${toBase64Url(cipher)}`;
}

/** Decrypt "iv.ciphertext" produced by encryptText. Throws on a wrong key. */
export async function decryptText(blob, keyB64) {
  const [ivPart, dataPart] = String(blob).split(".");
  if (!ivPart || !dataPart) throw new Error("Malformed encrypted payload");
  const key = await importKey(keyB64, "decrypt");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivPart) },
    key,
    fromBase64Url(dataPart)
  );
  return textDecoder.decode(plain);
}

/**
 * Build the shareable link for one participant.
 *
 * Both the key and the ciphertext live in the fragment, so the link is
 * self-contained: nothing is stored anywhere and no server ever sees it.
 * The honest consequence: the link IS the secret. Whoever holds it can read
 * that one assignment. Send each person only their own link.
 */
export function revealLink(baseUrl, keyB64, cipherBlob) {
  const url = new URL(baseUrl);
  url.hash = `k=${encodeURIComponent(keyB64)}&c=${encodeURIComponent(cipherBlob)}`;
  return url.toString();
}

/** Read {key, cipher} back out of location.hash. Returns null when absent. */
export function parseRevealHash(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const key = params.get("k");
  const cipher = params.get("c");
  return key && cipher ? { key, cipher } : null;
}
