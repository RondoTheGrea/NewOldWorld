/**
 * Byte builders for the generic ESC/POS command set used by cheap Bluetooth
 * thermal receipt printers. Pure functions — no native calls. Callers hand
 * the resulting bytes to the printer connection's write method.
 */

import { Buffer } from 'buffer';

import { replaceInvisible } from '@/lib/text-input';

const ESC = 0x1b;
const GS = 0x1d;

function bytes(...values: number[]): number[] {
  return values;
}

/**
 * On this link there is no difference between text and commands — the printer
 * reads one byte stream and treats 0x1b (ESC) or 0x1d (GS) as the start of an
 * instruction. So any control character inside *text* is a command the user
 * never meant to send: a customer name pasted from somewhere else could cut
 * the paper mid-receipt, or switch the printer into a mode the rest of the
 * receipt then prints in.
 *
 * Every such character becomes a space — one character for one character, so a
 * line that was laid out to 32 columns still lines up. Tabs and newlines get
 * the same treatment because a "line" here is by definition one line; the
 * caller ends it.
 */
function printableText(text: string): string {
  return replaceInvisible(text, ' ').replace(/[\t\n]/g, ' ');
}

function textBytes(text: string): number[] {
  return Array.from(Buffer.from(printableText(text), 'utf-8'));
}

/** Resets the printer to its power-on state. Send this first. */
export function init(): number[] {
  return bytes(ESC, 0x40);
}

/** Plain text followed by a line feed. */
export function line(text = ''): number[] {
  return [...textBytes(text), 0x0a];
}

/** Blank line(s). */
export function feed(lines = 1): number[] {
  return bytes(ESC, 0x64, lines);
}

/** Centers subsequent lines until alignLeft() is called. */
export function alignCenter(): number[] {
  return bytes(ESC, 0x61, 0x01);
}

export function alignLeft(): number[] {
  return bytes(ESC, 0x61, 0x00);
}

export function boldOn(): number[] {
  return bytes(ESC, 0x45, 0x01);
}

export function boldOff(): number[] {
  return bytes(ESC, 0x45, 0x00);
}

/**
 * Double width *and* height, for the store name. Note this halves how many
 * characters fit on a line, so text printed at this size must be laid out
 * against half the usual column count.
 */
export function sizeDouble(): number[] {
  return bytes(GS, 0x21, 0x11);
}

export function sizeNormal(): number[] {
  return bytes(GS, 0x21, 0x00);
}

/** Feeds paper and cuts it. Most generic printers only support a full cut. */
export function cut(): number[] {
  return bytes(GS, 0x56, 0x00);
}

/** Joins command arrays into a single byte array ready to write. */
export function build(...parts: number[][]): number[] {
  return parts.flat();
}
