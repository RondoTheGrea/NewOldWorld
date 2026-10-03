/**
 * Cleaning up text the user typed — or, much more likely, pasted — before it
 * is stored.
 *
 * Nothing here is about SQL injection: every query in this app is
 * parameterised (`?` placeholders), so a value can never be read as SQL no
 * matter what it contains. What these helpers defend against is the stuff a
 * keyboard can't produce but the clipboard can:
 *
 * - **Invisible characters.** Zero-width spaces and the bidirectional
 *   overrides can make a stored value look like something it isn't — or a
 *   "name" made entirely of zero-width spaces, which passes an "is it empty?"
 *   check and then shows up blank everywhere.
 * - **Control codes.** These eventually reach a thermal printer as raw bytes,
 *   where 0x1b is not a character but the start of a printer *command*
 *   (lib/escpos.ts blocks that too — belt and braces, since receipts already
 *   saved on the phone never came through here).
 * - **Unbounded length.** A pasted wall of text is not an attack so much as an
 *   accident, but a 50,000-character store name still prints as a metre of
 *   receipt paper and drags every list it appears in.
 */

/**
 * Characters that are never legitimate typed input: C0/C1 control codes,
 * zero-width and word-joiner characters, the line/paragraph separators, and
 * the bidi embedding/override/isolate controls.
 *
 * Tab (0x09) and newline (0x0a) are deliberately left out — the two helpers
 * below each decide what to do with them.
 *
 * Written as code-point ranges and assembled at runtime rather than typed as a
 * regex literal: a literal here is either a wall of escapes or, worse, real
 * control characters sitting invisibly in the source file.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008], // C0 controls up to backspace
  [0x000b, 0x001f], // C0 controls after newline — includes ESC (0x1b)
  [0x007f, 0x009f], // delete + C1 controls
  [0x200b, 0x200f], // zero-width space/joiners + LTR/RTL marks
  [0x2028, 0x2029], // line + paragraph separators
  [0x202a, 0x202e], // bidi embedding and override
  [0x2060, 0x2064], // word joiner + invisible maths operators
  [0x2066, 0x206f], // bidi isolates + deprecated formatting
  [0xfeff, 0xfeff], // byte-order mark / zero-width no-break space
];

const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(
    ([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`,
  ).join('')}]`,
  'g',
);

/**
 * Swaps every invisible/control character for `replacement`. Pass `''` to drop
 * them (what the two sanitizers below do) or `' '` where the character count
 * matters — lib/escpos.ts uses a space so that neutralising a character can't
 * shift the columns of an already-laid-out receipt line.
 */
export function replaceInvisible(value: string, replacement: string): string {
  return value.replace(INVISIBLE, replacement);
}

/**
 * Cuts to `maxLength`, then drops a trailing lone high surrogate. Slicing a
 * string can land in the middle of an emoji or a rarer CJK character, and half
 * a character is a broken value that can throw when it's later encoded.
 */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength).replace(/[\uD800-\uDBFF]$/, '');
}

/**
 * For fields that are one line: store name, contact name, phone number.
 * Newlines and tabs from a paste become ordinary spaces, runs of whitespace
 * collapse to one, and the result is trimmed and capped.
 */
export function sanitizeSingleLine(value: string, maxLength: number): string {
  // Carriage returns are normalised to newlines *first*: they're control
  // characters, so replaceInvisible would otherwise delete them outright and
  // silently join the words on either side.
  const collapsed = replaceInvisible(normalizeNewlines(value), '').replace(/\s+/g, ' ').trim();
  return truncate(collapsed, maxLength).trim();
}

/** CRLF (and a lone CR) to a plain newline. */
function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/**
 * For fields where line breaks are genuinely useful: address, description.
 * Keeps single newlines, collapses everything else — trailing spaces on a
 * line, runs of blank lines — so the stored value is what it looks like.
 */
export function sanitizeMultiline(value: string, maxLength: number): string {
  const collapsed = replaceInvisible(normalizeNewlines(value), '')
    // Runs of spaces and tabs, but not newlines.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncate(collapsed, maxLength).trim();
}
