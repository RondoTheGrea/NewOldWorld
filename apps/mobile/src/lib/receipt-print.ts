/**
 * The printed receipt layout, ported from the old POS's PrintableReceipt.
 *
 * The old app rendered the receipt as React Native views, screenshotted them
 * and printed the image. Here the receipt goes to a Bluetooth thermal printer
 * as ESC/POS text, so the layout is done in *characters* instead of pixels:
 * one function builds a list of finished lines, and two renderers consume it —
 * the on-screen preview (components/receipt-print-preview-modal.tsx) and the
 * printer itself. That's what makes the preview WYSIWYG: it isn't a lookalike,
 * it's the same lines in a monospace font.
 *
 * Nothing here touches Bluetooth or the database, so it runs anywhere,
 * including web.
 */

import type { BusinessSettings } from '@/context/business-settings';
import { formatBusinessDate, formatBusinessTime } from '@/lib/business-day';
import * as escpos from '@/lib/escpos';
import type { ReceiptDetail } from '@/lib/receipt-types';
import { replaceInvisible } from '@/lib/text-input';

/**
 * Characters per line. 32 is the standard for 58mm paper, which is what the
 * cheap handheld Bluetooth printers use. For an 80mm printer this becomes 48
 * and the column widths below need to be re-shared out to match.
 */
export const RECEIPT_COLUMNS = 32;

/**
 * What the paper calls itself, and the marking underneath it. Both are there
 * for one reason: under BIR RR 18-2012 a delivery receipt is a *supplementary*
 * commercial document, while a Sales Invoice is the *principal* evidence of a
 * sale of goods — and since the EOPT Act (RA 11976 / RR 7-2024) the Sales
 * Invoice is the document a seller of goods is actually required to issue.
 *
 * This app prints the supplementary one. The business issues the registered
 * Sales Invoice separately, and that split is what keeps this from being a
 * "sales machine" under RR 11-2004 / RMO 24-2023, which would otherwise need
 * BIR accreditation and a Permit to Use before a driver could hand out a
 * single copy.
 *
 * The classification lives on the paper, not in the product name, so neither
 * of these is decoration: the title says which of the two documents this is,
 * and the notice is BIR's own required wording for a supplementary document
 * (they are not valid proof for a buyer's input-tax claim). Don't drop either
 * one to save two lines of thermal paper.
 *
 * The wording is BIR's, not ours, so it can't be shortened or paraphrased into
 * something friendlier — it is the exact phrase an examiner looks for. It goes
 * last, under the business's own ending message, where a stamp belongs.
 */
const DocumentTitle = 'DELIVERY RECEIPT';
const InputTaxNotice = 'THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX';

/**
 * Blank lines fed after the last printed line, so the receipt clears the print
 * head far enough to be torn off. This is paper the preview never shows — the
 * preview renders the built lines, and these are pure margin — so it is the one
 * thing that can look right on screen and come out of the printer too long.
 * Keep it at the tear-off distance and no more: on a 58mm printer that gap is
 * a few millimetres, and the cut command advances the paper again on the models
 * that have a cutter.
 */
const TearOffFeedLines = 2;

// The item table's four columns, left to right. These must add up to exactly
// RECEIPT_COLUMNS or every row will wrap.
const NAME_WIDTH = 12;
const QTY_WIDTH = 4;
const PRICE_WIDTH = 7;
const TOTAL_WIDTH = 9;

// An item name never leaves its own column, no matter how long it is — it
// carries on down as many rows as it needs. One character of the column is
// always left empty so that even a full-width name keeps a gap between itself
// and a four-digit quantity.
const NAME_TEXT_WIDTH = NAME_WIDTH - 1;
const NAME_CONTINUATION_INDENT = '  ';
const NAME_CONTINUATION_WIDTH = NAME_WIDTH - NAME_CONTINUATION_INDENT.length;

/**
 * One finished line of the receipt. `text` is already padded out into its
 * columns, so a renderer only has to apply the three attributes and emit it.
 */
export type ReceiptPrintLine = {
  text: string;
  align: 'left' | 'center';
  bold: boolean;
  /** Double width + height, so only half as many characters fit on the line. */
  double: boolean;
};

/**
 * The peso sign is deliberately absent from every amount. Cheap ESC/POS
 * printers only speak single-byte code pages, so a "₱" prints as a random
 * glyph or nothing at all — a plain "P" is what these receipts have always
 * used in practice. The preview uses the same "P" so it stays honest.
 */
function money(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function peso(value: number): string {
  return `P${money(value)}`;
}

/**
 * Amounts inside the item table, which is the one place where characters are
 * genuinely scarce — no thousands separator, so a big line total (1,000 pieces
 * of anything adds up fast) still leaves a gap between the Price and Total
 * columns instead of running into it. The summary lines below the table have
 * the whole width to themselves and keep their separators.
 */
function tableAmount(value: number): string {
  return value.toFixed(2);
}

/**
 * Every piece of text that comes from *data* rather than from this file's own
 * literals — a customer name, a bread type, the business settings the
 * dashboard owns — passes through here first.
 *
 * lib/escpos.ts neutralises control characters again on its way to the
 * printer, and that is what actually stops a stray 0x1b from being read as a
 * printer command. Doing it here as well is about the *preview*: it renders
 * these same lines, so cleaning the text before the layout measures it is what
 * keeps the two identical, character for character.
 */
function fromData(text: string): string {
  return replaceInvisible(text, ' ');
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

/**
 * Right-aligns into a column. Deliberately does *not* truncate: everything
 * padded this way is an amount, and a silently shortened amount is a wrong
 * number on a customer's receipt. An over-long value pushes the row wide
 * instead, which is obvious the moment anyone looks at it.
 */
function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/**
 * Greedy word wrap, hard-splitting any single word too long for a line.
 * `restWidth` is the width of every line after the first, which is what lets
 * an item name start beside the Qty column and then carry on indented
 * underneath — see itemRow.
 */
function wrapColumn(text: string, firstWidth: number, restWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  const limit = () => (lines.length === 0 ? firstWidth : restWidth);

  function flush() {
    lines.push(current);
    current = '';
  }

  for (const word of text.split(/\s+/).filter(Boolean)) {
    let remaining = word;

    while (remaining.length > 0) {
      const capacity = limit() - (current ? current.length + 1 : 0);

      if (remaining.length <= capacity) {
        current = current ? `${current} ${remaining}` : remaining;
        remaining = '';
      } else if (current) {
        // Out of room on this line — start the next one and try again.
        flush();
      } else {
        // Too long even for a line of its own, so split it mid-word.
        current = remaining.slice(0, limit());
        remaining = remaining.slice(limit());
        flush();
      }
    }
  }

  if (current) flush();
  return lines.length > 0 ? lines : [''];
}

function wrap(text: string, width: number): string[] {
  return wrapColumn(text, width, width);
}

function left(text: string, bold = false): ReceiptPrintLine {
  return { text, align: 'left', bold, double: false };
}

function blank(): ReceiptPrintLine {
  return left('');
}

function rule(char: '=' | '-'): ReceiptPrintLine {
  return left(char.repeat(RECEIPT_COLUMNS));
}

/**
 * Centered text. The renderers centre it themselves (the printer has its own
 * centring command), so this only has to wrap it to the right width — half
 * width when the line is printed double-size.
 */
function centered(text: string, { bold = false, double = false } = {}): ReceiptPrintLine[] {
  const width = double ? Math.floor(RECEIPT_COLUMNS / 2) : RECEIPT_COLUMNS;
  return wrap(text, width).map((part) => ({ text: part, align: 'center' as const, bold, double }));
}

/**
 * Centered text that honours line breaks the user typed. The receipt ending
 * message is edited in a textarea on the dashboard, so a break there is a
 * deliberate layout choice ("Thank you!" / "See you next week") and has to
 * survive to the paper — `centered` alone would rewrap it into one paragraph.
 *
 * Each typed line is still wrapped to the column width, so a break can only
 * ever add lines, never push text off the paper. A blank line stays a blank
 * line — `wrap('')` returns a single empty line — which is the only way to
 * space the block out.
 */
function centeredBlock(text: string, options: { bold?: boolean; double?: boolean } = {}): ReceiptPrintLine[] {
  // A carriage return is a control character, so fromData has already turned
  // a CRLF into a space followed by the newline — splitting on the newline
  // alone is enough, and the stray space goes with the trim.
  return text.split('\n').flatMap((part) => centered(part.trim(), options));
}

/** `Label:            value`, value flushed to the right edge. */
function labelValue(label: string, value: string, bold = false): ReceiptPrintLine {
  const gap = Math.max(1, RECEIPT_COLUMNS - label.length - value.length);
  return left(label + ' '.repeat(gap) + value, bold);
}

/**
 * `Label: value`, with any wrapped or extra values hanging under the first one
 * so the label column stays readable:
 *
 *     Customer: Mary's Bakeshop
 *               (Maria Santos)
 */
function infoRow(label: string, ...values: string[]): ReceiptPrintLine[] {
  const indent = ' '.repeat(label.length + 1);
  const valueWidth = RECEIPT_COLUMNS - indent.length;
  const lines: ReceiptPrintLine[] = [];

  for (const value of values) {
    for (const part of wrap(value, valueWidth)) {
      lines.push(left(lines.length === 0 ? `${label} ${part}` : indent + part));
    }
  }

  return lines;
}

/** `------------ RETURNS -----------`, the old receipt's returns banner. */
function banner(label: string): ReceiptPrintLine {
  const padded = ` ${label} `;
  const remaining = Math.max(0, RECEIPT_COLUMNS - padded.length);
  const before = Math.floor(remaining / 2);
  return left('-'.repeat(before) + padded + '-'.repeat(remaining - before), true);
}

function tableHeader(): ReceiptPrintLine {
  return left(
    padRight('Item', NAME_WIDTH) +
      padLeft('Qty', QTY_WIDTH) +
      padLeft('Price', PRICE_WIDTH) +
      padLeft('Total', TOTAL_WIDTH),
    true,
  );
}

/**
 * One item line. A name too long for its column carries on underneath rather
 * than being cut off — on 12 characters of paper, truncating would make half
 * the bread types unidentifiable.
 */
function itemRow(
  name: string,
  quantity: number,
  unitPrice: number,
  { negative = false } = {},
): ReceiptPrintLine[] {
  // The first row carries the numbers; the rest of a long name hangs
  // underneath it, indented so it reads as a continuation and not as another
  // item — for as many rows as the name needs. Every one of those rows stays
  // inside the name column, so nothing ever collides with Qty.
  const nameLines = wrapColumn(fromData(name), NAME_TEXT_WIDTH, NAME_CONTINUATION_WIDTH);
  const lineTotal = unitPrice * quantity;
  const total = `${negative ? '-' : ''}${tableAmount(lineTotal)}`;

  return [
    left(
      padRight(nameLines[0], NAME_WIDTH) +
        padLeft(String(quantity), QTY_WIDTH) +
        padLeft(tableAmount(unitPrice), PRICE_WIDTH) +
        padLeft(total, TOTAL_WIDTH),
    ),
    ...nameLines.slice(1).map((part) => left(NAME_CONTINUATION_INDENT + part)),
  ];
}

/** The old POS's wording, kept as-is so receipts read the same as before. */
function paymentText(detail: ReceiptDetail): string {
  if (detail.status !== 'finalized' || !detail.paymentMethod) return 'Not Specified';

  switch (detail.paymentMethod) {
    case 'cash':
      return 'Cash';
    case 'gcash':
      return 'GCash';
    case 'cheque':
      return 'Cheque';
    case 'credit':
      return 'Credit (Pay Later)';
    case 'partial':
      return `Partial Payment (${peso(detail.amountPaid ?? 0)} Down)`;
  }
}

/**
 * Uppercased so it reads as a reference code rather than as a stray id. It is
 * a minted uuid, not a series — a delivery receipt has no invoice numbering to
 * imitate, and imitating one would work against the split described above.
 */
export function formatReceiptNumber(id: string): string {
  return id.toUpperCase();
}

/**
 * Deliberately in Manila time, not the phone's — see lib/business-day.ts. The
 * receipt is the copy the customer keeps, so a device with auto-timezone off
 * would otherwise print every pre-8am receipt dated the day before, with
 * nothing on the paper to show it was wrong.
 */
function formatPrintDate(timestamp: number): string {
  return `${formatBusinessDate(timestamp)} - ${formatBusinessTime(timestamp)}`;
}

/**
 * Builds the whole receipt, top to bottom. Items and returns keep the order
 * they were entered in (receipt-db reads them back `ORDER BY rowid`), so two
 * printings of the same receipt are always identical.
 */
export function buildReceiptPrintLines(detail: ReceiptDetail, business: BusinessSettings): ReceiptPrintLine[] {
  const issuedAt = detail.status === 'finalized' && detail.finalizedAt ? detail.finalizedAt : detail.createdAt;
  const lines: ReceiptPrintLine[] = [];

  lines.push(...centered(fromData(business.name), { bold: true, double: true }));
  lines.push(...centered(DocumentTitle, { bold: true }));
  lines.push(rule('='));

  lines.push(...infoRow('DR No.:', formatReceiptNumber(detail.id)));
  lines.push(...infoRow('Date:', formatPrintDate(issuedAt)));
  lines.push(
    ...infoRow(
      'Customer:',
      fromData(detail.customerName),
      ...(detail.customerContactName ? [`(${fromData(detail.customerContactName)})`] : []),
    ),
  );

  lines.push(rule('='));
  lines.push(tableHeader());
  lines.push(rule('-'));

  for (const item of detail.items) {
    lines.push(...itemRow(item.name, item.quantity, item.unitPrice));
  }

  lines.push(rule('-'));
  lines.push(labelValue('Subtotal:', peso(detail.subtotal)));

  if (detail.returns.length > 0) {
    lines.push(blank());
    lines.push(banner('RETURNS'));
    for (const line of detail.returns) {
      lines.push(...itemRow(line.name, line.quantity, line.unitPrice, { negative: true }));
    }
    lines.push(labelValue('Returns Total:', `-${peso(detail.returnsTotal)}`));
  }

  lines.push(rule('='));
  lines.push(
    labelValue(
      'TOTAL:',
      detail.total < 0 ? `-${peso(Math.abs(detail.total))}` : peso(detail.total),
      true,
    ),
  );
  lines.push(rule('='));

  lines.push(blank());
  lines.push(...centered('Payment Method:', { bold: true }));
  lines.push(...centered(paymentText(detail)));

  // Not on the old receipt, but a partial payment is the one case where the
  // customer's copy has to say what's still owed.
  if (detail.status === 'finalized' && detail.paymentMethod === 'partial' && detail.amountPaid != null) {
    lines.push(...centered(`Balance Due: ${peso(detail.total - detail.amountPaid)}`, { bold: true }));
  }

  // Who delivered it — the agents snapshotted onto the receipt when it was
  // finalized, not resolved from the run now (see agentNames in
  // lib/receipt-types.ts). Laid out like the payment block above it because it
  // answers the same kind of question about the sale rather than about the
  // goods.
  //
  // Omitted entirely when there is no name, which is what keeps every receipt
  // finalized before this existed printing exactly as it always did — an empty
  // "Agents:" heading over nothing would be worse than the line's absence.
  if (detail.agentNames) {
    lines.push(blank());
    lines.push(...centered('Agents:', { bold: true }));
    lines.push(...centered(fromData(detail.agentNames)));
  }

  lines.push(blank());
  lines.push(...centered(`Contact: ${fromData(business.contactNumber)}`));
  lines.push(blank());
  lines.push(...centeredBlock(fromData(business.receiptEndingMessage), { bold: true }));
  lines.push(blank());
  lines.push(...centered(InputTaxNotice));

  return lines;
}

/**
 * Renders built lines to ESC/POS bytes. Attribute commands are only emitted
 * when something actually changes, which keeps the payload small — these
 * printers receive over a slow Bluetooth serial link.
 */
export function receiptPrintBytes(lines: ReceiptPrintLine[]): number[] {
  const parts: number[][] = [escpos.init()];
  let align: ReceiptPrintLine['align'] = 'left';
  let bold = false;
  let double = false;

  for (const line of lines) {
    if (line.align !== align) {
      parts.push(line.align === 'center' ? escpos.alignCenter() : escpos.alignLeft());
      align = line.align;
    }
    if (line.bold !== bold) {
      parts.push(line.bold ? escpos.boldOn() : escpos.boldOff());
      bold = line.bold;
    }
    if (line.double !== double) {
      parts.push(line.double ? escpos.sizeDouble() : escpos.sizeNormal());
      double = line.double;
    }
    parts.push(escpos.line(line.text));
  }

  // Back to a clean state, then feed the receipt clear of the print head so it
  // can be torn off (printers without a cutter simply ignore the cut).
  parts.push(
    escpos.sizeNormal(),
    escpos.boldOff(),
    escpos.alignLeft(),
    escpos.feed(TearOffFeedLines),
    escpos.cut(),
  );
  return escpos.build(...parts);
}
