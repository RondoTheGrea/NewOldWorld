/**
 * The one place ids are minted — for stock ledger entries, receipts and
 * customers alike.
 *
 * These ids matter more than they used to. They are no longer just SQLite
 * primary keys: each one becomes the **Firestore document id** its row is
 * uploaded to (see lib/sync.ts). That is what makes an upload safe to repeat —
 * re-sending the same row writes the same document instead of creating a
 * second one — but it also means a duplicate id is no longer a local
 * curiosity. Two devices minting the same id would have one truck's receipt
 * silently overwrite another's.
 *
 * The id that used to be generated here was:
 *
 *     `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
 *
 * Its weakness is that the only thing separating two devices is those seven
 * base-36 characters — about 7.8 × 10^10 values — drawn from a PRNG, with
 * nothing tying an id to the device or the app launch that made it. Two phones
 * writing in the same millisecond rely entirely on that draw differing.
 *
 * (It also slices a fixed window, `[2, 9)`, out of a *variable-length* string:
 * a value whose base-36 form is short — 0.5 renders as "0.i" — yields a
 * one-character suffix. A full-entropy double essentially never lands on one,
 * so this is a latent sharp edge rather than something that was happening,
 * but a fixed-length encoding costs nothing and removes the question.)
 *
 * ## Why the ids below can't realistically collide
 *
 * The guarantee doesn't rest on randomness alone, because a phone's
 * `Math.random()` is a plain PRNG and React Native ships no Web Crypto by
 * default. It rests on three independent parts, each closing a different door:
 *
 * 1. **A per-launch tag.** `processTag` is drawn once when this module loads
 *    and is shared by every id from that app launch. Two ids can only collide
 *    if they were minted in the same launch of the app on the same phone — a
 *    different phone, or the same phone after a restart, draws a different tag.
 * 2. **A counter.** Within one launch the counter strictly increases, so two
 *    ids from the same launch are *always* different, even in the same
 *    millisecond and even if the random source returned identical bytes. This
 *    is the part that makes same-device collisions impossible rather than
 *    merely unlikely.
 * 3. **A timestamp**, which both sorts the ids roughly by creation time and
 *    separates two launches that happened to draw the same tag.
 *
 * So a collision needs two different launches to draw the same 8-character tag
 * *and* land in the same millisecond *and* be at the same counter value. With
 * 36^8 ≈ 2.8 × 10^12 tags across a handful of trucks, that does not happen.
 *
 * Crypto-quality randomness is still used when the platform offers it (it does
 * on web, and on native if a polyfill is ever added), purely to strengthen
 * point 1 — nothing here depends on it being present.
 */

const Alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Characters of randomness identifying this app launch. 36^8 ≈ 2.8e12. */
const ProcessTagLength = 8;

/** Extra randomness per id. Belt and braces — the counter already separates them. */
const RandomSuffixLength = 12;

/**
 * Random bytes from the platform's CSPRNG when there is one, falling back to
 * `Math.random()`.
 *
 * `globalThis.crypto` is present on web and absent on React Native's Hermes
 * engine unless something polyfills it, so both paths are real. The fallback is
 * not a security hole here: ids are not secrets and not guess-resistant by
 * design — see the header for why uniqueness doesn't depend on this.
 */
function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
    return bytes;
  }

  for (let i = 0; i < count; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/**
 * A fixed-length lowercase alphanumeric string — fixed length being the point,
 * unlike the `.slice()` of a `Math.random().toString(36)` it replaces.
 *
 * 256 is not a multiple of 36, so taking `byte % 36` would favour the first
 * four letters slightly. That bias is harmless for ids, but rejecting the
 * unusable top of the range costs nothing and keeps the character space even.
 */
function randomString(length: number): string {
  const limit = 256 - (256 % Alphabet.length);
  let out = '';

  while (out.length < length) {
    for (const byte of randomBytes(length - out.length + 8)) {
      if (byte >= limit) continue;
      out += Alphabet[byte % Alphabet.length];
      if (out.length === length) break;
    }
  }

  return out;
}

/** Drawn once per app launch — see point 1 in the header. */
const processTag = randomString(ProcessTagLength);

let counter = 0;

/**
 * A new id, unique across every device and every app launch.
 *
 * Shaped `<time>-<launch tag><counter>-<random>`, e.g.
 * `m9x2k4p1-f3k9d0zq1-8s2mq0lz4bnv`. The leading timestamp means ids sort
 * roughly by creation order, which is convenient when reading raw rows or
 * Firestore documents; nothing depends on it.
 */
export function generateId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${processTag}${counter.toString(36)}-${randomString(RandomSuffixLength)}`;
}
